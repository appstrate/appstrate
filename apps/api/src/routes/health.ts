// SPDX-License-Identifier: Apache-2.0

import { Hono, type MiddlewareHandler } from "hono";
import { sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { getVersionInfo } from "../lib/version.ts";
import { ApiError } from "../lib/errors.ts";

const startedAt = Date.now();

// ─── Readiness ───

let serverReady = false;
let agentsHealthy = false;

/**
 * Flip the process to "ready". Called once from `index.ts` when
 * `bootBackground()` resolves — i.e. when orphan cleanup, the system-package
 * DB sync and every worker are done. Recoverable boot failures are carried in
 * `readiness` so `/health` can report a degraded component without keeping the
 * whole API behind the starting gate. The port is already bound well before
 * this; see {@link bootGate}.
 */
export function markServerReady(readiness: { agentsHealthy: boolean }): void {
  agentsHealthy = readiness.agentsHealthy;
  serverReady = true;
}

/** Test-only reset of the module-level readiness flag. */
export function _resetServerReadyForTesting(): void {
  serverReady = false;
  agentsHealthy = false;
}

/**
 * Boot gate — the mirror image of the shutdown gate. Between the port bind and
 * the end of `bootBackground()` the process is listening but not ready, so
 * rather than run a request against half-initialized state (or leave the socket
 * closed and hand clients a bare CONNREFUSED) it answers an explicit 503 that
 * says which state we are in.
 *
 * `/health` is answered from HERE while starting, not by the router below: the
 * real checks would otherwise report on state that is still being built. Every
 * other path gets an RFC 9457 `starting` problem file.
 *
 * INVARIANT: this gate does NOT make deferring route registration safe. Hono
 * throws `Can not add a route since the matcher is already built` on any route
 * added after the first request is matched, so the whole route table — core and
 * module — is still registered before the bind. See `lib/boot.ts`.
 */
export function bootGate(): MiddlewareHandler {
  return async (c, next) => {
    if (serverReady) return next();
    if (c.req.path === "/health") {
      return c.json({ status: "starting", version: getVersionInfo() }, 503, {
        "Retry-After": "1",
      });
    }
    throw new ApiError({
      status: 503,
      code: "starting",
      title: "Service Unavailable",
      detail: "Server is still starting up",
    });
  };
}

const healthRouter = new Hono();

healthRouter.get("/health", async (c) => {
  const checks: Record<string, { status: string; latency_ms?: number }> = {};

  // Database check
  const dbStart = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    checks.database = {
      status: "healthy",
      latency_ms: Date.now() - dbStart,
    };
  } catch {
    checks.database = { status: "unhealthy", latency_ms: Date.now() - dbStart };
  }

  // Agent execution readiness comes from the orchestrator's boot handshake.
  // System packages are optional catalogue entries and say nothing about
  // whether the platform can launch a run.
  checks.agents = {
    status: agentsHealthy ? "healthy" : "degraded",
  };

  const hasUnhealthy = Object.values(checks).some((c) => c.status === "unhealthy");
  const allHealthy = Object.values(checks).every((c) => c.status === "healthy");
  const status = hasUnhealthy ? "unhealthy" : allHealthy ? "healthy" : "degraded";
  const httpStatus = hasUnhealthy ? 503 : 200;

  return c.json(
    {
      status,
      version: getVersionInfo(),
      uptime_ms: Date.now() - startedAt,
      checks,
    },
    httpStatus,
  );
});

export default healthRouter;
