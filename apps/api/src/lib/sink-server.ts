// SPDX-License-Identifier: Apache-2.0

/**
 * Guest-facing sink listener (`SINK_LISTENER_PORT`).
 *
 * Sandboxed run workloads (Firecracker microVMs, containers) reach the
 * platform for exactly three things:
 *
 *   - the HMAC-signed run-event sink — `POST /api/runs/:runId/events`
 *     (+ `/finalize`, `/heartbeat`) and the workspace self-provisioning
 *     fetches `GET /api/runs/:runId/workspace|documents[/:name]`
 *     (agent entrypoint, `runtime-pi/entrypoint.ts`);
 *   - the run-token `/internal/*` routes — run-history, memories,
 *     oauth-token, integration credentials, mcp-server bundles
 *     (sidecar, `runtime-pi/sidecar/`);
 *   - `GET /health` (operator diagnostics; the Firecracker daemon's
 *     boot-time guest-path probe GETs the platform URL and only cares
 *     that the L3 path connects).
 *
 * Exposing the FULL API to guests forces their network policy (e.g. the
 * Firecracker host/guest nftables rules, which scope by ip:port) to admit
 * every platform route, leaving isolation to per-route L7 auth — an SSRF
 * surface. This app mounts ONLY the routes above, so pointing the guest
 * path at this listener makes the existing port-scoped firewall rules
 * sink-only automatically. Everything else 404s (problem+json, matching
 * the main app's unknown-`/api/*` handler).
 *
 * Both mounted routers authenticate at the route layer (Standard Webhooks
 * HMAC / signed run token) — in `index.ts` they sit behind `skipAuth`
 * bypasses, so no auth pipeline is mounted here and the auth model is
 * identical on both listeners. The route factories are REUSED, never
 * duplicated: handler behavior cannot drift between listeners.
 *
 * Lifecycle mirrors the main server: same shutdown POST gate (via
 * `isShuttingDown`), and the process exit in `lib/shutdown.ts` closes
 * both listeners together.
 */

import { Hono } from "hono";
import { getEnv } from "@appstrate/env";
import { requestId } from "../middleware/request-id.ts";
import { errorHandler } from "../middleware/error-handler.ts";
import { bodyLimit } from "../middleware/body-limit.ts";
import { shutdownGate } from "../middleware/shutdown-gate.ts";
import { createRunsEventsRouter } from "../routes/runs-events.ts";
import { createInternalRouter } from "../routes/internal.ts";
import healthRouter from "../routes/health.ts";
import { notFound } from "./errors.ts";
import type { AppEnv } from "../types/index.ts";

export interface SinkAppOptions {
  /**
   * Shutdown gate shared with the main app (`index.ts` flips it in
   * `createShutdownHandler`'s callback): while draining, new POSTs are
   * rejected 503 on BOTH listeners so behavior does not depend on which
   * port a runner targets.
   */
  isShuttingDown?: () => boolean;
}

/** Build the minimal guest-facing Hono app served on `SINK_LISTENER_PORT`. */
export function createSinkApp(opts: SinkAppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);
  app.use("*", requestId());
  // Same global body cap as the main app. The main app's single exemption
  // (`/api/uploads/_content`, signed-token streaming sink) is not mounted
  // here, so the cap applies unconditionally.
  app.use("*", bodyLimit(getEnv().API_BODY_LIMIT_BYTES));
  app.use(
    "*",
    shutdownGate(() => opts.isShuttingDown?.() ?? false),
  );

  app.route("/", healthRouter);
  app.route("/api", createRunsEventsRouter());
  app.route("/internal", createInternalRouter());

  // Default-deny: anything not explicitly mounted above does not exist on
  // this listener — including every session/API-key platform route.
  app.all("*", (c) => {
    const pathname = new URL(c.req.url).pathname;
    throw notFound(`Endpoint not available on the sink listener: ${c.req.method} ${pathname}`);
  });

  return app;
}
