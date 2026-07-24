// SPDX-License-Identifier: Apache-2.0

/**
 * Provider-agnostic telemetry façade.
 *
 * The platform core instruments its business seams (run pipeline, container
 * spawn, LLM proxy, HTTP server spans) through the helpers below — and ONLY
 * through them. Core carries no telemetry SDK: every helper is a true no-op
 * (`runWithSpan` is literally `return fn()`) until a provider is installed.
 *
 * A telemetry backend ships as an opt-in module (e.g.
 * `@appstrate/module-observability`, OpenTelemetry) that builds a
 * {@link TelemetryProvider} at `init()` and registers it via
 * {@link installTelemetryProvider}. Module init runs after the Hono app is
 * wired but before the first request, so the provider is in place before any
 * span-producing code path executes. Disabling the module (drop it from
 * `MODULES`) leaves the façade permanently no-op — zero allocation, zero SDK
 * load, zero behavior change.
 *
 * Deliberately NOT auto-instrumentation: spans stay explicit at the
 * orchestration seams (see `docs/architecture/OBSERVABILITY.md` — module
 * patching is unreliable under Bun, and explicit seams keep the
 * no-op-when-disabled guarantee exact).
 */

// Hono is an optional peer dependency (same posture as `module.ts`): the type
// below is erased at runtime, and only consumers that wire HTTP middleware
// (the platform API) resolve it.
import type { MiddlewareHandler } from "hono";

/** Span attribute bag. `undefined` values are skipped by providers. */
export type TelemetryAttributes = Record<string, string | number | boolean | undefined>;

export interface TelemetrySpanOptions {
  /**
   * Span taxonomy, provider-agnostic. `"internal"` (default) for in-process
   * seams, `"server"` for the inbound HTTP request span.
   */
  kind?: "internal" | "server";
  /** W3C traceparent to parent this span under (cross-process linking). */
  traceparent?: string | null;
  attributes?: TelemetryAttributes;
}

/** Pull source for the scheduler queue-depth gauge. */
export type QueueDepthSource = () => number | Promise<number> | null | undefined;

/** Snapshot of the storage-deletion outbox backlog, emitted once per worker pass. */
export interface StorageDeletionStats {
  /** Pending (not-yet-completed, due or backing-off) jobs. */
  backlog: number;
  /** Age of the oldest pending job, in seconds (0 when none). */
  oldestPendingAgeSeconds: number;
  /** Pending jobs past the dead-letter attempt threshold (still retrying). */
  deadLetters: number;
}

/**
 * Contract a telemetry module implements. Method semantics (attribute names,
 * units, cardinality clamps) are documented on the façade functions below —
 * a provider MUST preserve them so dashboards survive a backend swap.
 */
export interface TelemetryProvider {
  runWithSpan<T>(name: string, opts: TelemetrySpanOptions, fn: () => T): T;
  currentTraceparent(): string | undefined;
  /**
   * Whether the inbound W3C `traceparent` header should be trusted for span
   * parenting (anti-spoof gate — see `runTraceparent` in the runs route).
   */
  trustsIncomingTrace(): boolean;
  recordRunDuration(durationMs: number, attrs: { status: string }): void;
  recordRunTerminal(attrs: { status: string; errorCode?: string }): void;
  recordContainerSpawn(durationMs: number, attrs?: { sidecar?: boolean; errorType?: string }): void;
  recordLlmLatency(durationMs: number, attrs: { api_shape?: string; status?: number }): void;
  recordProcessAnomaly(attrs: { kind: string }): void;
  recordStorageDeletionSweep(stats: StorageDeletionStats): void;
  recordStorageDeletionResult(attrs: { result: string }): void;
  setQueueDepthSource(source: QueueDepthSource): void;
  /**
   * Optional HTTP server-span middleware, mounted by the platform's global
   * telemetry middleware (`app.use("*")` delegation). Absent → requests pass
   * through untouched.
   */
  httpMiddleware?: MiddlewareHandler;
  /** Flush + tear down. Called once from the platform shutdown sequence. */
  shutdown(): Promise<void>;
}

// ─── Façade state ────────────────────────────────────────────────

let provider: TelemetryProvider | null = null;

/**
 * Buffered queue-depth source: the scheduler may register its source before
 * the telemetry module's `init()` installs the provider (both run during
 * boot). Stored unconditionally and replayed on install so registration
 * order doesn't matter.
 */
let queueDepthSource: QueueDepthSource | null = null;

/**
 * Install the active telemetry provider. Called once by a telemetry module's
 * `init()`. Last-write-wins on a repeat call (module init is fatal-on-error
 * and runs once, so this only matters for tests).
 */
export function installTelemetryProvider(p: TelemetryProvider): void {
  provider = p;
  if (queueDepthSource) p.setQueueDepthSource(queueDepthSource);
}

/** Test-only: drop the installed provider + buffered state. */
export function _resetTelemetryForTesting(): void {
  provider = null;
  queueDepthSource = null;
}

// ─── Span helpers (no-op without a provider) ─────────────────────

/**
 * Run `fn` inside a fresh span (and bind its trace context into the logger's
 * AsyncLocalStorage — provider responsibility). Without a provider this is
 * literally `return fn()` — no span, no context switch, no allocation.
 */
export function runWithSpan<T>(name: string, opts: TelemetrySpanOptions, fn: () => T): T {
  return provider ? provider.runWithSpan(name, opts, fn) : fn();
}

/**
 * The active span's context serialized as a W3C `traceparent`, or `undefined`
 * when no provider / no active span. Used to forward the in-process span as
 * the parent of a cross-process child (e.g. the agent container's events).
 */
export function currentTraceparent(): string | undefined {
  return provider?.currentTraceparent();
}

/**
 * Whether the inbound `traceparent` header is trusted for span parenting.
 * Default `false` (fresh root spans) — an unauthenticated caller must not be
 * able to splice server spans into an attacker-chosen trace.
 */
export function telemetryTrustsIncomingTrace(): boolean {
  return provider?.trustsIncomingTrace() ?? false;
}

// ─── Metric recorders (no-op without a provider) ─────────────────

/** Wall-clock run duration, tagged by terminal status. Recorded in ms. */
export function recordRunDuration(durationMs: number, attrs: { status: string }): void {
  provider?.recordRunDuration(durationMs, attrs);
}

/**
 * One run reaching a terminal status. Providers clamp `errorCode` to a
 * bounded allowlist — a runner-controlled string must never explode metric
 * cardinality.
 */
export function recordRunTerminal(attrs: { status: string; errorCode?: string }): void {
  provider?.recordRunTerminal(attrs);
}

/**
 * Time to provision the isolation boundary + sidecar/agent workloads.
 * `errorType` is present on failure only (`boundary` | `workload`) and
 * clamped provider-side.
 */
export function recordContainerSpawn(
  durationMs: number,
  attrs?: { sidecar?: boolean; errorType?: string },
): void {
  provider?.recordContainerSpawn(durationMs, attrs);
}

/**
 * One upstream LLM call observed at the platform proxy seam. An absent
 * `status` means the call failed before producing a response.
 */
export function recordLlmLatency(
  durationMs: number,
  attrs: { api_shape?: string; status?: number },
): void {
  provider?.recordLlmLatency(durationMs, attrs);
}

/**
 * One async error that escaped every request try/catch and hit the
 * process-level last-resort handler (`uncaughtException` |
 * `unhandledRejection`). A non-zero rate is a regression to chase.
 */
export function recordProcessAnomaly(attrs: { kind: string }): void {
  provider?.recordProcessAnomaly(attrs);
}

/**
 * Snapshot the storage-deletion outbox backlog for the last-value gauges
 * (`appstrate.storage_deletion.backlog` / `.oldest_pending_age_seconds` /
 * `.dead_letters`). Called once per worker pass with cheap COUNT/MIN queries.
 */
export function recordStorageDeletionSweep(stats: StorageDeletionStats): void {
  provider?.recordStorageDeletionSweep(stats);
}

/**
 * One storage-deletion job attempt reaching an outcome — `completed` (object
 * gone) or `failed` (delete threw, will retry). Feeds the
 * `appstrate.storage_deletion.result` counter.
 */
export function recordStorageDeletionResult(attrs: { result: "completed" | "failed" }): void {
  provider?.recordStorageDeletionResult(attrs);
}

/**
 * Register the scheduler's queue-depth source for the provider's observable
 * gauge. Safe to call before a provider is installed — the value is buffered
 * and replayed by {@link installTelemetryProvider}.
 */
export function setQueueDepthSource(source: QueueDepthSource): void {
  queueDepthSource = source;
  provider?.setQueueDepthSource(source);
}

// ─── HTTP middleware + shutdown delegation ───────────────────────

/**
 * The provider's HTTP server-span middleware, or `undefined` when no provider
 * (or the provider contributes none). Read per-request by the platform's
 * global telemetry middleware so a provider installed during boot is picked
 * up without re-registering `app.use`.
 */
export function telemetryHttpMiddleware(): MiddlewareHandler | undefined {
  return provider?.httpMiddleware;
}

/**
 * Flush + tear down the active provider. Called from the platform shutdown
 * sequence AFTER in-flight runs are drained and workers are stopped (so
 * terminal counters/histograms are already recorded) and BEFORE DB/Redis
 * teardown — see `apps/api/src/lib/shutdown.ts` for the full invariant.
 * Best-effort no-op without a provider.
 */
export async function shutdownTelemetry(): Promise<void> {
  await provider?.shutdown();
}
