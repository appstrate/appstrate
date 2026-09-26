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
 *   - `checks.agents` is read live from the orchestrator readiness module, so
 *     a failed boot handshake that later succeeds on retry flips `/health`
 *     back to healthy without a restart (#1129).
 *
 * The gate is mounted before EVERY other middleware except request-id /
 * telemetry / client-ip / CORS / body-limit, so this test mounts it the same
 * way over a stand-in route table.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import healthRouter, {
  bootGate,
  markServerReady,
  _resetServerReadyForTesting,
} from "../../../src/routes/health.ts";
import { initRealtime } from "../../../src/services/realtime.ts";
import {
  initializeAgentRuntime,
  isAgentRuntimeReady,
  _resetAgentRuntimeReadinessForTesting,
} from "../../../src/services/orchestrator/agent-runtime-readiness.ts";
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

type HealthBody = { status: string; checks?: { agents?: { status?: string } } };

async function getHealth(app: Hono<AppEnv>): Promise<{ httpStatus: number; body: HealthBody }> {
  const res = await app.request("/health");
  return { httpStatus: res.status, body: (await res.json()) as HealthBody };
}

/** An orchestrator whose boot handshake fails, as on a runtime-image pull error. */
const failingOrchestrator = {
  initialize: async (): Promise<void> => {
    throw new Error("runtime image pull failed");
  },
};

describe("boot gate", () => {
  beforeEach(() => {
    _resetServerReadyForTesting();
    _resetAgentRuntimeReadinessForTesting();
  });

  afterEach(() => {
    // Never leave the module-level flags flipped (or a retry timer armed) for
    // other suites.
    _resetServerReadyForTesting();
    _resetAgentRuntimeReadinessForTesting();
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

    // Same space instance across the transition — Hono's matcher is already
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

  it("reports healthy once boot and the agents orchestrator are ready", async () => {
    const app = buildGatedApp();
    // The rollup also reads `checks.realtime`, which boot installs; do the same
    // here so this asserts the agents dimension it is about.
    await initRealtime();
    await initializeAgentRuntime({ initialize: async () => {} });
    markServerReady();

    const res = await app.request("/health");

    const body = (await res.json()) as {
      status: string;
      uptime_ms?: number;
      checks?: { agents?: { status?: string } };
    };
    expect(res.status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(body.checks?.agents?.status).toBe("healthy");
    expect(typeof body.uptime_ms).toBe("number");
  });

  it("reports degraded when boot completes without the agents orchestrator", async () => {
    const app = buildGatedApp();
    await initializeAgentRuntime(failingOrchestrator);
    markServerReady();

    const { httpStatus, body } = await getHealth(app);

    expect(httpStatus).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.checks?.agents?.status).toBe("degraded");
  });

  it("recovers to healthy without a restart once the orchestrator init succeeds on retry (#1129)", async () => {
    const app = buildGatedApp();
    await initRealtime();
    let dependencyUp = false;
    await initializeAgentRuntime(
      {
        initialize: async () => {
          if (!dependencyUp) throw new Error("runtime image pull failed");
        },
      },
      { initialDelayMs: 1, maxDelayMs: 4 },
    );
    markServerReady();

    const before = await getHealth(app);
    expect(before.body.status).toBe("degraded");
    expect(before.body.checks?.agents?.status).toBe("degraded");

    // The transient failure clears; the background retry must pick it up.
    dependencyUp = true;
    const deadline = Date.now() + 2_000;
    while (!isAgentRuntimeReady() && Date.now() < deadline) await Bun.sleep(5);

    const after = await getHealth(app);
    expect(after.httpStatus).toBe(200);
    expect(after.body.status).toBe("healthy");
    expect(after.body.checks?.agents?.status).toBe("healthy");
  });
});
