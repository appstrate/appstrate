// SPDX-License-Identifier: Apache-2.0

/**
 * Boot gate — the readiness half of the start/stop pair (`routes/health.ts`).
 *
 * `apps/api/src/index.ts` binds the port as soon as `bootCritical()` (core
 * migrations, module load, auth, fail-fast config validation) is done, then
 * runs `bootBackground()` — orphan cleanup, the system-package DB sync, every
 * worker — without blocking the bind. That window used to be a closed socket:
 * clients got CONNREFUSED with nothing to distinguish "starting" from "dead".
 *
 * The gate turns that window into an explicit answer:
 *
 *   - `/health` reports `status: "starting"` with 503 + `Retry-After`, so a
 *     readiness probe never routes traffic to a half-built process.
 *   - Every other path gets an RFC 9457 `starting` problem document, NOT the
 *     handler — routes must never run before their dependencies exist.
 *   - Once `markServerReady()` fires, the gate is transparent: requests reach
 *     the real handlers, `/health` runs its real checks.
 *   - Once `markServerDraining()` fires, `/health` returns 503 while normal
 *     requests keep flowing until the process receives its shutdown signal.
 *
 * The gate is mounted before EVERY other middleware except request-id /
 * telemetry / client-ip / CORS / body-limit, so this test mounts it the same
 * way over a stand-in route table.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import healthRouter, {
  bootGate,
  markServerDraining,
  markServerReady,
  _resetServerReadyForTesting,
} from "../../../src/routes/health.ts";
import { errorHandler } from "../../../src/middleware/error-handler.ts";
import type { AppEnv } from "../../../src/types/index.ts";

/** Production-shaped mount: error handler → boot gate → health → app routes. */
function buildGatedApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use("*", bootGate());
  app.route("/", healthRouter);
  app.get("/api/agents", (c) => c.json({ data: [] }));
  app.get("/", (c) => c.html("<html>spa</html>"));
  return app;
}

describe("boot gate", () => {
  beforeEach(() => {
    _resetServerReadyForTesting();
  });

  afterEach(() => {
    // Never leave the module-level flag flipped for other suites.
    _resetServerReadyForTesting();
  });

  // ─── While starting ────────────────────────────────────

  it("answers /health with an explicit `starting` 503 instead of the real checks", async () => {
    const app = buildGatedApp();

    const res = await app.request("/health");

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("1");
    const body = (await res.json()) as { status: string; checks?: unknown };
    expect(body.status).toBe("starting");
    // The real health handler was NOT reached — it would have run the DB probe
    // and emitted `checks`.
    expect(body.checks).toBeUndefined();
  });

  it("refuses application routes with an RFC 9457 `starting` problem document", async () => {
    const app = buildGatedApp();

    const res = await app.request("/api/agents");

    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = (await res.json()) as { code?: string; title?: string; detail?: string };
    expect(body.code).toBe("starting");
    expect(body.detail).toContain("starting up");
  });

  it("refuses the SPA fallback too — a boot window serves no page", async () => {
    const app = buildGatedApp();

    const res = await app.request("/");

    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("<html>");
  });

  it("gates every method, not just reads", async () => {
    const app = buildGatedApp();

    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      const res = await app.request("/api/agents", { method });
      expect(res.status).toBe(503);
    }
  });

  // ─── After boot completes ──────────────────────────────

  it("becomes transparent once the server is marked ready", async () => {
    const app = buildGatedApp();

    // Same app instance across the transition — Hono's matcher is already
    // built by the requests above, which is exactly why no route may be
    // registered after the bind.
    expect((await app.request("/api/agents")).status).toBe(503);

    markServerReady();

    const res = await app.request("/api/agents");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });

    const spa = await app.request("/");
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain("<html>");
  });

  it("hands /health back to the real handler once ready", async () => {
    const app = buildGatedApp();
    markServerReady();

    const res = await app.request("/health");

    // The real handler ran: it reports uptime + per-dependency checks, and no
    // longer carries the `starting` marker.
    const body = (await res.json()) as {
      status: string;
      uptime_ms?: number;
      checks?: Record<string, unknown>;
    };
    expect(body.status).not.toBe("starting");
    expect(body.checks).toBeDefined();
    expect(typeof body.uptime_ms).toBe("number");
  });

  // ─── During a rolling-deploy drain ─────────────────────────────

  it("withdraws readiness without rejecting normal requests", async () => {
    const app = buildGatedApp();
    markServerReady();
    markServerDraining();

    const health = await app.request("/health");
    expect(health.status).toBe(503);
    expect(health.headers.get("Retry-After")).toBe("1");
    expect(await health.json()).toMatchObject({ status: "draining" });

    // The load balancer may need one health-check interval to observe the
    // transition. Requests routed during that window must still complete.
    const request = await app.request("/api/agents");
    expect(request.status).toBe(200);
    expect(await request.json()).toEqual({ data: [] });
  });

  it("does not become ready again if boot finishes after draining starts", async () => {
    const app = buildGatedApp();
    markServerDraining();
    markServerReady();

    const health = await app.request("/health");
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ status: "draining" });
  });
});
