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
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricReader,
} from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";

import { runWithTraceContext } from "@appstrate/core/logger";
import { getErrorMessage } from "@appstrate/core/errors";
import { parseTraceparent } from "@appstrate/afps-runtime/transport";
import { getEnv } from "@appstrate/env";
import { logger } from "../lib/logger.ts";

const INSTRUMENTATION_SCOPE = "@appstrate/api";

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

/**
 * Pull provider for the scheduler queue-depth observable gauge. The scheduler
 * registers its BullMQ counts source here at boot; the gauge (created on
 * enable) reads it lazily on each metric collection. Stored unconditionally
 * so registration order vs. {@link initObservability} doesn't matter.
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
}

/**
 * Initialize OpenTelemetry. Idempotent and defensive: a misconfiguration can
 * never crash boot — on any error we log and continue with observability
 * disabled. Safe to call once at process start, before the server begins
 * serving so span/metric context is available on the first request.
 */
export function initObservability(opts: InitObservabilityOptions = {}): void {
  if (initialized) return;

  const env = getEnv();
  const isEnabled =
    opts.enabled ?? (env.OTEL_ENABLED || env.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined);

  if (!isEnabled) {
    // True no-op mode. Mark initialized so repeat calls stay cheap; leave
    // every OTel object unallocated.
    initialized = true;
    enabled = false;
    return;
  }

  try {
    const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME });

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
        exportIntervalMillis: env.OTEL_METRIC_EXPORT_INTERVAL_MS,
      });
    const mp = new MeterProvider({ resource, readers: [reader] });
    metrics.setGlobalMeterProvider(mp);
    meterProvider = mp;
    meter = mp.getMeter(INSTRUMENTATION_SCOPE);
    createInstruments(meter);

    enabled = true;
    initialized = true;
    logger.info("OpenTelemetry observability enabled", {
      service: env.OTEL_SERVICE_NAME,
      endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "otlp-default",
    });
  } catch (err) {
    // Never let telemetry wiring take down the process. Disable and move on.
    enabled = false;
    initialized = true;
    logger.error("OpenTelemetry init failed — continuing without observability", {
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
  runDuration = m.createHistogram("appstrate.run.duration_ms", {
    unit: "ms",
    description: "Wall-clock duration of a run from launch to terminal status.",
  });
  runTerminal = m.createCounter("appstrate.run.terminal_total", {
    description: "Count of runs reaching a terminal status, tagged by status + error_code.",
  });
  containerSpawn = m.createHistogram("appstrate.run.container_spawn_ms", {
    unit: "ms",
    description: "Time to provision the isolation boundary + sidecar/agent workloads.",
  });
  llmLatency = m.createHistogram("appstrate.llm.latency_ms", {
    unit: "ms",
    description: "Upstream LLM call latency observed at the platform proxy seam.",
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
}

// ─── Public state accessors ──────────────────────────────────────

/** Whether OTel is active. When false, every helper below is a no-op. */
export function isObservabilityEnabled(): boolean {
  return enabled;
}

/**
 * Register the scheduler's queue-depth source for the observable gauge.
 * No-op-friendly: the value is stored regardless of enabled-state, so the
 * scheduler can call this without first checking whether OTel is on.
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
  return `00-${sc.traceId}-${sc.spanId}-${flagsHex(sc.traceFlags)}`;
}

// ─── Metric recorders (all no-op when disabled) ──────────────────

export function recordRunDuration(durationMs: number, attrs: { status: string }): void {
  if (!enabled) return;
  runDuration?.record(durationMs, attrs);
}

export function recordRunTerminal(attrs: { status: string; errorCode?: string }): void {
  if (!enabled) return;
  runTerminal?.add(1, {
    status: attrs.status,
    error_code: attrs.errorCode ?? "none",
  });
}

export function recordContainerSpawn(durationMs: number, attrs?: { sidecar?: boolean }): void {
  if (!enabled) return;
  containerSpawn?.record(durationMs, { sidecar: attrs?.sidecar ?? false });
}

export function recordLlmLatency(
  durationMs: number,
  attrs: { api_shape?: string; status?: number; outcome: "success" | "error" },
): void {
  if (!enabled) return;
  llmLatency?.record(durationMs, {
    api_shape: attrs.api_shape ?? "unknown",
    outcome: attrs.outcome,
    ...(attrs.status !== undefined ? { status_code: attrs.status } : {}),
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
