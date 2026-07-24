// SPDX-License-Identifier: Apache-2.0

/**
 * OpenTelemetry bootstrap + thin instrumentation seam for the platform API.
 *
 * Design contract
 * ───────────────
 *   - **Disabled by default.** Until {@link initObservability} runs with a
 *     configured OTLP endpoint (or `OTEL_ENABLED=true`), every helper here is
 *     a true no-op: `runWithSpan` calls its callback directly, the metric
 *     recorders return immediately, and NO OTel object is allocated. OSS
 *     deployments without a collector pay zero overhead and observe zero
 *     behavior change.
 *   - **Single AsyncLocalStorage.** We do NOT fork the trace-context storage.
 *     {@link runWithSpan} bridges the active OTel span's `SpanContext` into the
 *     existing logger {@link runWithTraceContext} store (packages/core/logger),
 *     so log lines and spans share the same `trace_id` automatically.
 *   - **Reuses the existing traceparent seam.** Inbound W3C `traceparent`
 *     strings are parsed with the same {@link parseTraceparent} the request-id
 *     middleware and the runtime sink already use — no second wire parser.
 *   - **Collector-agnostic.** Exporters read the standard OTLP env vars
 *     (`OTEL_EXPORTER_OTLP_ENDPOINT`, `_HEADERS`, `_PROTOCOL`, …) directly, so
 *     any OTLP/HTTP backend (Collector, Grafana Alloy, Honeycomb, …) works.
 */

import {
  trace,
  context,
  metrics,
  propagation,
  SpanKind,
  SpanStatusCode,
  type Span,
  type Tracer,
  type Meter,
  type Attributes,
  type Histogram,
  type Counter,
  type Context,
} from "@opentelemetry/api";
// The SDK packages below are TYPE-ONLY imports (erased at runtime). Their
// runtime values are pulled in via dynamic `import()` inside the enabled
// branch of `initObservability`, so a disabled boot loads only the
// `@opentelemetry/api` no-op above — never the heavy SDK.
import type {
  BasicTracerProvider,
  SpanExporter,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { MeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";

import { runWithTraceContext, type Logger } from "@appstrate/core/logger";
import { getErrorMessage } from "@appstrate/core/errors";
import { parseTraceparent, formatTraceparent } from "@appstrate/afps-runtime/transport";
import { readOtelEnv } from "./env.ts";

const INSTRUMENTATION_SCOPE = "@appstrate/module-observability";

// ─── Module state (undefined / false until enabled) ──────────────
let enabled = false;
let initialized = false;
let tracer: Tracer | undefined;
let meter: Meter | undefined;
let tracerProvider: BasicTracerProvider | undefined;
let meterProvider: MeterProvider | undefined;

// Metric instruments — created once on enable.
let runDuration: Histogram | undefined;
let runTerminal: Counter | undefined;
let containerSpawn: Histogram | undefined;
let llmLatency: Histogram | undefined;
let processAnomaly: Counter | undefined;
let storageDeletionResult: Counter | undefined;

// Last-value snapshot of the storage-deletion outbox backlog, pushed by the
// worker once per pass (via the telemetry façade) and read lazily by the three
// observable gauges below on each metric collection. Same push-snapshot →
// observe-on-collect shape as the scheduler queue-depth gauge.
let storageDeletionBacklog = 0;
let storageDeletionOldestPendingAgeSeconds = 0;
let storageDeletionDeadLetters = 0;

/**
 * Pull provider for the scheduler queue-depth observable gauge. The scheduler
 * registers its BullMQ counts source (via the core telemetry façade); the
 * gauge (created on enable) reads it lazily on each metric collection. Stored
 * unconditionally so registration order vs. {@link initObservability} doesn't
 * matter.
 */
let queueDepthProvider: (() => number | Promise<number> | null | undefined) | null = null;

// ─── Init / shutdown ─────────────────────────────────────────────

export interface InitObservabilityOptions {
  /** Force enabled-state, overriding env derivation (used by tests). */
  enabled?: boolean;
  /** Inject a span exporter (tests use {@link InMemorySpanExporter}). */
  spanExporter?: SpanExporter;
  /** Inject a metric reader (tests use an in-memory reader). */
  metricReader?: MetricReader;
  /** Boot logger (module init passes `ctx.services.logger`). Silent when absent (tests). */
  logger?: Logger;
}

/**
 * Initialize OpenTelemetry. Idempotent and defensive: a misconfiguration can
 * never crash boot — on any error we log and continue with observability
 * disabled. Must be `await`ed once from the module's `init()`, which runs
 * before the server accepts its first request, so span/metric context is
 * available on the first request.
 *
 * Async because the heavy SDK packages are dynamically imported only on the
 * enabled path — a disabled boot never loads or parses them.
 */
export async function initObservability(opts: InitObservabilityOptions = {}): Promise<void> {
  if (initialized) return;

  const env = readOtelEnv();
  const isEnabled = opts.enabled ?? env.enabled;

  if (!isEnabled) {
    // True no-op mode. Mark initialized so repeat calls stay cheap; leave
    // every OTel object unallocated. The SDK import() calls below never run
    // on this path — only `@opentelemetry/api` (the no-op) is loaded.
    initialized = true;
    enabled = false;
    return;
  }

  try {
    // Lazy-load the SDK only when telemetry is actually enabled, so OSS /
    // no-collector deployments never pay the import+parse cost.
    const [
      { BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor },
      { MeterProvider, PeriodicExportingMetricReader },
      { resourceFromAttributes },
      { ATTR_SERVICE_NAME },
      { W3CTraceContextPropagator },
      { AsyncLocalStorageContextManager },
      { OTLPTraceExporter },
      { OTLPMetricExporter },
    ] = await Promise.all([
      import("@opentelemetry/sdk-trace-base"),
      import("@opentelemetry/sdk-metrics"),
      import("@opentelemetry/resources"),
      import("@opentelemetry/semantic-conventions"),
      import("@opentelemetry/core"),
      import("@opentelemetry/context-async-hooks"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/exporter-metrics-otlp-http"),
    ]);

    const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: env.serviceName });

    // Tracing — batch in production, simple (synchronous) when a test
    // injects its own exporter so finished spans are observable immediately.
    const spanProcessor: SpanProcessor = opts.spanExporter
      ? new SimpleSpanProcessor(opts.spanExporter)
      : new BatchSpanProcessor(new OTLPTraceExporter());
    const tp = new BasicTracerProvider({ resource, spanProcessors: [spanProcessor] });
    // SDK 2.x BasicTracerProvider has no `register()` convenience — set the
    // globals explicitly. The AsyncLocalStorage context manager is what makes
    // `context.with(...)` propagate the active span across awaits (and lets the
    // logger bridge see it); the W3C propagator handles traceparent extract.
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    trace.setGlobalTracerProvider(tp);
    tracerProvider = tp;
    tracer = trace.getTracer(INSTRUMENTATION_SCOPE);

    // Metrics.
    const reader =
      opts.metricReader ??
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        // Fixed 60s flush cadence — fresh enough for dashboards, cheap on
        // export traffic. No custom env knob (YAGNI).
        exportIntervalMillis: 60_000,
      });
    const mp = new MeterProvider({ resource, readers: [reader] });
    metrics.setGlobalMeterProvider(mp);
    meterProvider = mp;
    meter = mp.getMeter(INSTRUMENTATION_SCOPE);
    createInstruments(meter);

    enabled = true;
    initialized = true;
    opts.logger?.info("OpenTelemetry observability enabled", {
      service: env.serviceName,
      endpoint: env.endpoint ?? "otlp-default",
    });
  } catch (err) {
    // Never let telemetry wiring take down the process. Disable and move on.
    enabled = false;
    initialized = true;
    opts.logger?.error("OpenTelemetry init failed — continuing without observability", {
      error: getErrorMessage(err),
    });
  }
}

/** Force-flush spans + metrics. Test-only — drives in-memory exporters. */
export async function _forceFlushForTesting(): Promise<void> {
  await tracerProvider?.forceFlush();
  await meterProvider?.forceFlush();
}

/** Flush + tear down providers. Best-effort; safe to call when disabled. */
export async function shutdownObservability(): Promise<void> {
  try {
    await meterProvider?.shutdown();
  } catch {
    // best-effort
  }
  try {
    await tracerProvider?.shutdown();
  } catch {
    // best-effort
  }
}

function createInstruments(m: Meter): void {
  // Durations are recorded in SECONDS (`unit:"s"`, per OTel semconv): runs span
  // ~1s to minutes, which lands inside the SDK's default histogram bucket range
  // — recording raw milliseconds (top default bucket 10000ms) dumped every run
  // into the (10000,+inf) overflow bucket, making p50/p95/p99 unusable. The
  // unit lives in `unit` only — not the metric name (OTel naming guidance). The
  // Prometheus exporter also auto-appends `_total` to counters, so the counter
  // name omits it to avoid a `_total_total` double suffix.
  runDuration = m.createHistogram("appstrate.run.duration", {
    unit: "s",
    description: "Wall-clock duration of a run from launch to terminal status.",
  });
  runTerminal = m.createCounter("appstrate.run.terminal", {
    description: "Count of runs reaching a terminal status, tagged by status + error_code.",
  });
  // container_spawn + llm.latency live in the sub-second to low-seconds range,
  // where the SDK's DEFAULT explicit buckets [0,5,10,25,…,10000] collapse every
  // value <5s into the single (0,5]s bucket — destroying p50/p95/p99 resolution.
  // Give each its own sub-second-aware boundaries via the OTel `advice` hint
  // (read by the default histogram aggregation; @opentelemetry/api ≥1.7).
  // run.duration stays on the default buckets — its seconds-to-minutes range
  // already lands across them.
  containerSpawn = m.createHistogram("appstrate.run.container_spawn", {
    unit: "s",
    description: "Time to provision the isolation boundary + sidecar/agent workloads.",
    advice: { explicitBucketBoundaries: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30] },
  });
  llmLatency = m.createHistogram("appstrate.llm.latency", {
    unit: "s",
    description: "Upstream LLM call latency observed at the platform proxy seam.",
    advice: { explicitBucketBoundaries: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60] },
  });
  processAnomaly = m.createCounter("appstrate.process.anomaly", {
    description:
      "Count of async errors that escaped every request try/catch and hit the " +
      "process-level last-resort handler, tagged by kind (uncaughtException|unhandledRejection).",
  });
  m.createObservableGauge("appstrate.scheduler.queue_depth", {
    description: "Pending jobs in the run-scheduler queue (BullMQ).",
  }).addCallback(async (result) => {
    const provider = queueDepthProvider;
    if (!provider) return;
    try {
      const depth = await provider();
      if (typeof depth === "number" && Number.isFinite(depth)) result.observe(depth);
    } catch {
      // A flaky queue read must not break metric collection.
    }
  });

  // Storage-deletion outbox: one counter (attempt outcomes) + three last-value
  // gauges reading the worker's pushed snapshot. Backlog + oldest-age surface a
  // stuck purge; dead_letters surfaces objects that keep failing to delete.
  storageDeletionResult = m.createCounter("appstrate.storage_deletion.result", {
    description: "Count of storage-deletion job attempts by outcome (completed|failed).",
  });
  m.createObservableGauge("appstrate.storage_deletion.backlog", {
    description: "Pending storage-deletion jobs (rows whose object is not yet purged).",
  }).addCallback((result) => result.observe(storageDeletionBacklog));
  m.createObservableGauge("appstrate.storage_deletion.oldest_pending_age_seconds", {
    unit: "s",
    description: "Age of the oldest pending storage-deletion job.",
  }).addCallback((result) => result.observe(storageDeletionOldestPendingAgeSeconds));
  m.createObservableGauge("appstrate.storage_deletion.dead_letters", {
    description: "Pending storage-deletion jobs past the dead-letter attempt threshold.",
  }).addCallback((result) => result.observe(storageDeletionDeadLetters));
}

// ─── Public state accessors ──────────────────────────────────────

/** Whether OTel is active. When false, every helper below is a no-op. */
export function isObservabilityEnabled(): boolean {
  return enabled;
}

/**
 * Register the scheduler's queue-depth source for the observable gauge.
 * No-op-friendly: the value is stored regardless of enabled-state, so the
 * façade can replay it without first checking whether OTel is on.
 */
export function setQueueDepthProvider(
  provider: () => number | Promise<number> | null | undefined,
): void {
  queueDepthProvider = provider;
}

// ─── Span helpers ────────────────────────────────────────────────

function flagsHex(traceFlags: number): string {
  return (traceFlags & 0xff).toString(16).padStart(2, "0");
}

/**
 * Build the parent {@link Context} for a new span. When a W3C `traceparent`
 * string is supplied (e.g. the inbound request header, or the run's captured
 * trace), the span is parented under it so the whole API→run→container path
 * shares one `trace_id`. Otherwise the current active context is used.
 */
function parentContext(traceparent?: string | null): Context {
  const parsed = parseTraceparent(traceparent);
  if (!parsed) return context.active();
  return trace.setSpanContext(context.active(), {
    traceId: parsed.traceId,
    spanId: parsed.spanId,
    traceFlags: parseInt(parsed.flags, 16),
    isRemote: true,
  });
}

export interface SpanOptions {
  kind?: SpanKind;
  /** W3C traceparent to parent this span under (cross-process linking). */
  traceparent?: string | null;
  attributes?: Attributes;
}

/**
 * Run `fn` inside a fresh span AND bind that span's trace context into the
 * logger's AsyncLocalStorage so every log line emitted during `fn` carries the
 * matching `trace_id` / `span_id`. Handles sync + async `fn`, records
 * exceptions, and always ends the span.
 *
 * When observability is disabled this is literally `return fn()` — no span,
 * no context switch, no allocation.
 */
export function runWithSpan<T>(name: string, opts: SpanOptions, fn: () => T): T {
  if (!enabled || !tracer) return fn();

  const parent = parentContext(opts.traceparent);
  const span = tracer.startSpan(
    name,
    { kind: opts.kind ?? SpanKind.INTERNAL, attributes: opts.attributes },
    parent,
  );
  const ctxWithSpan = trace.setSpan(parent, span);
  const sc = span.spanContext();

  return context.with(ctxWithSpan, () =>
    runWithTraceContext(
      { traceId: sc.traceId, spanId: sc.spanId, traceFlags: flagsHex(sc.traceFlags) },
      () => endSpanAround(span, fn),
    ),
  );
}

function recordSpanError(span: Span, err: unknown): void {
  span.recordException(err instanceof Error ? err : { message: getErrorMessage(err) });
  // semconv `error.type` (Conditionally Required when the operation errors):
  // the exception class name — low-cardinality, bounded by the codebase's
  // error classes. Non-Error throwables map to the semconv fallback `_OTHER`.
  span.setAttribute(
    "error.type",
    err instanceof Error ? err.constructor.name || err.name : "_OTHER",
  );
  span.setStatus({ code: SpanStatusCode.ERROR, message: getErrorMessage(err) });
}

function endSpanAround<T>(span: Span, fn: () => T): T {
  let result: T;
  try {
    result = fn();
  } catch (err) {
    recordSpanError(span, err);
    span.end();
    throw err;
  }
  if (result instanceof Promise) {
    return result.then(
      (value) => {
        span.end();
        return value;
      },
      (err: unknown) => {
        recordSpanError(span, err);
        span.end();
        throw err;
      },
    ) as unknown as T;
  }
  span.end();
  return result;
}

/**
 * The active span, or `undefined` when none / disabled. Callers attach
 * attributes via optional chaining: `currentSpan()?.setAttribute(...)`.
 */
export function currentSpan(): Span | undefined {
  if (!enabled) return undefined;
  return trace.getActiveSpan();
}

/**
 * The active span's context serialized as a W3C `traceparent`, or `undefined`
 * when disabled / no active span. Used to forward the in-process span as the
 * parent of a cross-process child (e.g. the agent container's outbound calls).
 */
export function currentTraceparent(): string | undefined {
  const span = currentSpan();
  if (!span) return undefined;
  const sc = span.spanContext();
  if (!sc.traceId || !sc.spanId) return undefined;
  // Reuse the shared W3C serializer instead of re-templating the wire format.
  return formatTraceparent({
    traceId: sc.traceId,
    spanId: sc.spanId,
    flags: flagsHex(sc.traceFlags),
  });
}

// ─── Metric recorders (all no-op when disabled) ──────────────────

// Duration histograms record SECONDS (see createInstruments). Callers measure
// in milliseconds at the seam, so each recorder divides by 1000 on the way in.
const MS_PER_S = 1000;

/**
 * Allowlist of stable run-failure codes (documented on `RunError.code` in
 * `@appstrate/afps-runtime`). Clamping the metric label to this set keeps the
 * `error_code` dimension's cardinality bounded — a runner-controlled string can
 * never explode it. Unknown codes map to `"other"`, absent maps to `"none"`.
 */
const RUN_ERROR_CODES = new Set(["timeout", "manifest_invalid", "provider_unauthorized"]);

function clampErrorCode(code: string | undefined): string {
  if (code === undefined) return "none";
  return RUN_ERROR_CODES.has(code) ? code : "other";
}

/**
 * Bounded `error.type` values for the container-spawn histogram, naming the
 * provisioning phase that failed (isolation `boundary` create vs. `workload`
 * spawn). Same cardinality-clamp rationale as {@link clampErrorCode}: a raw
 * exception string would be unbounded. Unknown maps to `"other"`.
 */
const SPAWN_ERROR_TYPES = new Set(["boundary", "workload"]);

function clampSpawnError(type: string): string {
  return SPAWN_ERROR_TYPES.has(type) ? type : "other";
}

export function recordRunDuration(durationMs: number, attrs: { status: string }): void {
  if (!enabled) return;
  runDuration?.record(durationMs / MS_PER_S, attrs);
}

export function recordRunTerminal(attrs: { status: string; errorCode?: string }): void {
  if (!enabled) return;
  runTerminal?.add(1, {
    status: attrs.status,
    error_code: clampErrorCode(attrs.errorCode),
  });
}

/**
 * Record one async error that escaped the request lifecycle and reached the
 * process-level last-resort handler. A non-zero rate under normal load is a
 * real upstream regression to chase — NOT a healthy steady state.
 */
export function recordProcessAnomaly(attrs: { kind: string }): void {
  if (!enabled) return;
  processAnomaly?.add(1, { kind: attrs.kind });
}

export function recordStorageDeletionSweep(stats: {
  backlog: number;
  oldestPendingAgeSeconds: number;
  deadLetters: number;
}): void {
  if (!enabled) return;
  storageDeletionBacklog = stats.backlog;
  storageDeletionOldestPendingAgeSeconds = stats.oldestPendingAgeSeconds;
  storageDeletionDeadLetters = stats.deadLetters;
}

export function recordStorageDeletionResult(attrs: { result: string }): void {
  if (!enabled) return;
  storageDeletionResult?.add(1, { result: attrs.result });
}

export function recordContainerSpawn(
  durationMs: number,
  attrs?: { sidecar?: boolean; errorType?: string },
): void {
  if (!enabled) return;
  containerSpawn?.record(durationMs / MS_PER_S, {
    sidecar: attrs?.sidecar ?? false,
    // OTel semconv (Recording errors): a single duration histogram covers both
    // outcomes — `error.type` is present on FAILURE only and omitted on success,
    // so spawn error-rate and clean-latency are both derivable from one metric.
    ...(attrs?.errorType !== undefined ? { "error.type": clampSpawnError(attrs.errorType) } : {}),
  });
}

/**
 * Record one upstream LLM call observed at the platform proxy seam. Attributes
 * follow OTel HTTP semconv (mirroring {@link recordContainerSpawn}'s use of
 * `error.type`-on-failure-only):
 *
 *   - `http.response.status_code` — the upstream status, when a response was
 *     received. An ABSENT `status` means the call failed before producing a
 *     response (transport error / thrown fetch).
 *   - `error.type` — present on FAILURE only: the status code as a string for
 *     4xx/5xx upstream replies (semconv-sanctioned for non-exception errors),
 *     or the semconv fallback `_OTHER` when no response arrived. Success
 *     points carry neither, so clean latency stays filterable and error rate
 *     is derivable from one histogram. Both values are bounded by construction
 *     (status codes / a single sentinel) — no cardinality clamp needed.
 */
export function recordLlmLatency(
  durationMs: number,
  attrs: { api_shape?: string; status?: number },
): void {
  if (!enabled) return;
  const status = attrs.status;
  const errorType = status === undefined ? "_OTHER" : status >= 400 ? String(status) : undefined;
  llmLatency?.record(durationMs / MS_PER_S, {
    api_shape: attrs.api_shape ?? "unknown",
    ...(status !== undefined ? { "http.response.status_code": status } : {}),
    ...(errorType !== undefined ? { "error.type": errorType } : {}),
  });
}

// ─── Test-only reset ─────────────────────────────────────────────

/**
 * Reset all module + global OTel state so a subsequent {@link initObservability}
 * starts clean. Test-only — production never re-inits. Exported with the
 * `_…ForTesting` convention used elsewhere in the codebase.
 */
export async function _resetObservabilityForTesting(): Promise<void> {
  await shutdownObservability();
  trace.disable();
  metrics.disable();
  context.disable();
  propagation.disable();
  enabled = false;
  initialized = false;
  tracer = undefined;
  meter = undefined;
  tracerProvider = undefined;
  meterProvider = undefined;
  runDuration = undefined;
  runTerminal = undefined;
  containerSpawn = undefined;
  llmLatency = undefined;
  queueDepthProvider = null;
}
