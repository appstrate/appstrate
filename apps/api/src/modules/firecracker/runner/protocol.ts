// SPDX-License-Identifier: Apache-2.0

/**
 * Wire protocol between the platform's `firecracker` backend (its HTTP
 * client) and the `appstrate-runner` daemon (issue #819, phase 1).
 *
 * Single source of truth for both sides: the daemon (`./server.ts`)
 * validates every request body against these schemas, the client
 * (`../remote-orchestrator.ts`) types its calls from them. All payloads
 * are plain JSON mirrors of the `RunOrchestrator` value types — handles
 * and boundaries cross the wire verbatim and are treated as opaque by
 * the client.
 *
 * Wire casing note: this is an INTERNAL platform↔daemon protocol, not a
 * public HTTP API — payloads carry `@appstrate/core/platform-types`
 * shapes as-is (camelCase), the same way they cross the in-process
 * orchestrator boundary. Converting to snake_case here would force a
 * lossy rename layer around types the two sides already share.
 *
 * SECURITY: `POST /v1/sidecars` carries the run token and credential
 * bundle env. The transport MUST be a trusted link — same host, private
 * network, or TLS via a reverse proxy — and every request carries the
 * shared bearer token. See ../README.md ("Security posture").
 */

import { z } from "zod";

/**
 * Bumped on any wire-incompatible change. The client refuses to start
 * against a daemon speaking a different major protocol.
 */
export const RUNNER_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Platform-type mirrors
// ---------------------------------------------------------------------------

export const workloadHandleSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  role: z.string().min(1),
});

export const workloadResourcesSchema = z.object({
  memoryBytes: z.number().int().positive(),
  nanoCpus: z.number().int().positive(),
  pidsLimit: z.number().int().positive().optional(),
});

export const workloadSpecSchema = z.object({
  runId: z.string().min(1),
  role: z.string().min(1),
  image: z.string(),
  env: z.record(z.string(), z.string()),
  resources: workloadResourcesSchema,
  egress: z.boolean().optional(),
  maxLifetimeSeconds: z.number().int().positive().optional(),
});

export const workspaceHandleSchema = z.union([
  z.object({ kind: z.literal("volume"), name: z.string().min(1) }),
  z.object({ kind: z.literal("directory"), path: z.string().min(1) }),
]);

export const sidecarEndpointsSchema = z.object({
  sidecarUrl: z.string(),
  llmProxyUrl: z.string(),
  forwardProxyUrl: z.string(),
  noProxy: z.string(),
});

export const isolationBoundarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  workspace: workspaceHandleSchema,
  sidecarEndpoints: sidecarEndpointsSchema,
});

/**
 * `SidecarLaunchSpec` mirror. Loose on purpose: the spec is produced and
 * consumed by the same platform codebase on both ends — the daemon only
 * needs to pin the fields it inspects (`runToken`) and forwards the rest
 * untouched. A strict mirror would turn every additive core field into a
 * lockstep daemon redeploy.
 */
export const sidecarLaunchSpecSchema = z.looseObject({
  runToken: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

/**
 * Safe run-identifier charset. A runId reaches the daemon filesystem
 * verbatim — `join(FIRECRACKER_DATA_DIR, runId)` at boundary creation and
 * `<console-archive>/<runId>.log` at teardown — so a crafted value
 * (`../foo`, `/etc`, an embedded NUL) could escape the run tree. Restrict
 * it to the characters a real platform run id uses. Single source: reused
 * by the boundary-creation ingress AND the console `:id` guard
 * ({@link CONSOLE_ID_RE}).
 */
export const RUN_ID_RE = /^[A-Za-z0-9_.-]+$/;

export const createBoundaryBodySchema = z.object({
  runId: z.string().min(1).regex(RUN_ID_RE, "runId contains unsafe characters"),
  opts: z.object({ skipSidecar: z.boolean().optional() }).optional(),
});

export const removeBoundaryBodySchema = z.object({
  boundary: isolationBoundarySchema,
});

export const createSidecarBodySchema = z.object({
  runId: z.string().min(1),
  boundary: isolationBoundarySchema,
  spec: sidecarLaunchSpecSchema,
});

export const createWorkloadBodySchema = z.object({
  spec: workloadSpecSchema,
  boundary: isolationBoundarySchema,
});

export const handleBodySchema = z.object({
  handle: workloadHandleSchema,
});

export const stopWorkloadBodySchema = z.object({
  handle: workloadHandleSchema,
  timeoutSeconds: z.number().int().nonnegative().optional(),
});

export const logsBodySchema = z.object({
  handle: workloadHandleSchema,
  /**
   * Lines already received — the daemon skips that many lines so a
   * reconnecting client resumes without duplicating run logs.
   */
  skip: z.number().int().nonnegative().default(0),
});

export const stopRunBodySchema = z.object({
  runId: z.string().min(1),
  timeoutSeconds: z.number().int().nonnegative().optional(),
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  adapter: z.literal("firecracker"),
  protocol: z.number().int(),
  initialized: z.boolean(),
  // Guest-visible platform API URL the daemon advertises to its guests (its
  // FIRECRACKER_RUNNER_PLATFORM_URL). The client caches this from the
  // initialize() handshake so resolvePlatformApiUrl() needs no second call.
  platformUrl: z.string(),
  // Guest→platform self-verification result computed once at daemon boot
  // (see runner/net-probe.ts). Always sent — the handler defaults them when
  // the probe was skipped. `guestPathVerified` null = probe degraded/skipped
  // (tooling absent or platform down).
  platformReachable: z.boolean(),
  guestPathVerified: z.boolean().nullable(),
});

/** Long-poll answer: `done: false` means "still running, poll again". */
export const exitResponseSchema = z.union([
  z.object({ done: z.literal(false) }),
  z.object({ done: z.literal(true), code: z.number().int() }),
]);

export const stopResultResponseSchema = z.object({
  result: z.enum(["stopped", "not_found", "already_stopped"]),
});

/** Every non-2xx response body. */
export const errorResponseSchema = z.object({
  error: z.string(),
});

/** One NDJSON line on the `logs` stream. */
export const logLineSchema = z.object({
  line: z.string(),
});

/**
 * Liveness probe answer (issue #819, phase 4 — daemon observability).
 * `running` reflects whether the daemon still holds a live VMM process for
 * the workload. The platform's boot-phase heartbeat pump synthesises
 * heartbeats ONLY while this is `true`, so a dead VM is never masked.
 * `uptimeMs` is present once the microVM has booted.
 */
export const workloadStatusResponseSchema = z.object({
  running: z.boolean(),
  uptimeMs: z.number().int().nonnegative().optional(),
});

/** Default console tail served when `?tailBytes=` is absent or malformed. */
export const CONSOLE_DEFAULT_TAIL_BYTES = 64 * 1024;
/** Hard cap on the console tail — a request over this is clamped, not rejected. */
export const CONSOLE_MAX_TAIL_BYTES = 256 * 1024;

/**
 * A console `:id` is used verbatim to build the archive path
 * (`<archive-dir>/<id>.log`) — restrict it to run-identifier characters so
 * a crafted id can never traverse out of the archive directory. Same
 * charset as {@link RUN_ID_RE} (a console id IS a runId).
 */
export const CONSOLE_ID_RE = RUN_ID_RE;

/** Static Hono pattern for the console route (server side). */
export const CONSOLE_ROUTE_PATTERN = "/v1/workloads/:id/console";

/** Build the console path for a given id (client side). */
export function workloadConsolePath(id: string): string {
  return `/v1/workloads/${encodeURIComponent(id)}/console`;
}

/**
 * `?tailBytes=` query for the console route. Absent or malformed → the
 * default; a value over the cap is clamped down (never rejected) so a
 * caller can safely ask for "as much as allowed".
 */
export const consoleQuerySchema = z.object({
  tailBytes: z.coerce
    .number()
    .int()
    .positive()
    .catch(CONSOLE_DEFAULT_TAIL_BYTES)
    .transform((n) => Math.min(Math.max(n, 1), CONSOLE_MAX_TAIL_BYTES)),
});

// ---------------------------------------------------------------------------
// Endpoint map
// ---------------------------------------------------------------------------

/**
 * Route paths, shared so client and server can never drift. All bodies
 * are JSON; `logs` responds as an NDJSON stream (`application/x-ndjson`,
 * one `logLineSchema` object per line); `exit` long-polls up to
 * {@link EXIT_LONG_POLL_MS} before answering `{ done: false }`.
 */
export const RUNNER_ROUTES = {
  health: "/v1/health",
  createBoundary: "/v1/boundaries",
  removeBoundary: "/v1/boundaries/remove",
  createSidecar: "/v1/sidecars",
  createWorkload: "/v1/workloads",
  startWorkload: "/v1/workloads/start",
  stopWorkload: "/v1/workloads/stop",
  removeWorkload: "/v1/workloads/remove",
  waitForExit: "/v1/workloads/exit",
  streamLogs: "/v1/workloads/logs",
  // Boot-phase liveness probe (phase 4). Additive: an older daemon 404s
  // this route and the platform's heartbeat pump degrades to inert.
  workloadStatus: "/v1/workloads/status",
  stopRun: "/v1/runs/stop",
} as const;
// NOTE: the console route (`CONSOLE_ROUTE_PATTERN` / `workloadConsolePath`)
// is NOT in this map — it carries a path parameter and a query string, so
// it cannot be a single static string like the routes above.

/** How long the daemon holds an `exit` long-poll before `{ done: false }`. */
export const EXIT_LONG_POLL_MS = 45_000;
