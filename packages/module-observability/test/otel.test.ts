// SPDX-License-Identifier: Apache-2.0

/**
 * OpenTelemetry observability unit tests. Pure logic — no DB, no Docker.
 *
 * Proves the three contract guarantees from the bootstrap design:
 *   (a) disabled mode is a TRUE no-op (no span, no active context, recorders
 *       are inert);
 *   (b) enabled mode produces parent-child spans + run duration/terminal
 *       metrics for a simulated run path (in-memory exporters);
 *   (c) a `trace_id` carried on an inbound W3C traceparent flows into BOTH the
 *       OTel span and the shared logger trace context.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { getTraceContext } from "@appstrate/core/logger";
import {
  initObservability,
  isObservabilityEnabled,
  runWithSpan,
  currentSpan,
  currentTraceparent,
  recordRunDuration,
  recordRunTerminal,
  recordContainerSpawn,
  recordLlmLatency,
  recordDocumentCreated,
  recordDocumentDeleted,
  recordDocumentQuotaRejection,
  recordDocumentPartialPublication,
  setQueueDepthProvider,
  _resetObservabilityForTesting,
  _forceFlushForTesting,
} from "../src/otel.ts";

function findMetric(rms: ResourceMetrics[], name: string) {
  for (const rm of rms) {
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        if (m.descriptor.name === name) return m;
      }
    }
  }
  return undefined;
}

describe("observability — disabled (no-op)", () => {
  beforeEach(async () => {
    await _resetObservabilityForTesting();
    await initObservability({ enabled: false });
  });

  afterEach(async () => {
    await _resetObservabilityForTesting();
  });

  it("reports disabled", () => {
    expect(isObservabilityEnabled()).toBe(false);
  });

  it("runWithSpan calls fn directly with no active span and returns its value", async () => {
    let sawSpan = true;
    const result = await runWithSpan("noop.span", {}, async () => {
      sawSpan = currentSpan() !== undefined;
      return 42;
    });
    expect(result).toBe(42);
    expect(sawSpan).toBe(false);
  });

  it("does not bind a logger trace context", async () => {
    let ctxInside: unknown;
    await runWithSpan(
      "noop.span",
      { traceparent: "00-" + "a".repeat(32) + "-" + "b".repeat(16) + "-01" },
      async () => {
        ctxInside = getTraceContext();
      },
    );
    expect(ctxInside).toBeUndefined();
  });

  it("metric recorders + currentTraceparent are inert (never throw)", () => {
    expect(() => recordRunDuration(5, { status: "success" })).not.toThrow();
    expect(() => recordRunTerminal({ status: "failed", errorCode: "timeout" })).not.toThrow();
    expect(() => recordContainerSpawn(10, { sidecar: true })).not.toThrow();
    expect(() => recordLlmLatency(5, { api_shape: "openai", status: 200 })).not.toThrow();
    expect(() => recordDocumentCreated({ purpose: "agent_output" })).not.toThrow();
    expect(() => recordDocumentDeleted(2)).not.toThrow();
    expect(() => recordDocumentQuotaRejection()).not.toThrow();
    expect(() => recordDocumentPartialPublication()).not.toThrow();
    expect(currentTraceparent()).toBeUndefined();
  });
});

describe("observability — enabled (in-memory exporters)", () => {
  let spanExporter: InMemorySpanExporter;
  let metricExporter: InMemoryMetricExporter;

  beforeEach(async () => {
    await _resetObservabilityForTesting();
    spanExporter = new InMemorySpanExporter();
    metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    await initObservability({
      enabled: true,
      spanExporter,
      metricReader: new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 100_000,
      }),
    });
  });

  afterEach(async () => {
    await _resetObservabilityForTesting();
  });

  it("reports enabled", () => {
    expect(isObservabilityEnabled()).toBe(true);
  });

  it("produces parent-child spans for a simulated run path", async () => {
    await runWithSpan(
      "appstrate.run.execute",
      { attributes: { "appstrate.run.id": "run_test" } },
      async () => {
        await runWithSpan("appstrate.run.container", {}, async () => {
          // simulated container lifecycle
        });
      },
    );

    const spans = spanExporter.getFinishedSpans();
    const execute = spans.find((s) => s.name === "appstrate.run.execute") as ReadableSpan;
    const container = spans.find((s) => s.name === "appstrate.run.container") as ReadableSpan;

    expect(execute).toBeDefined();
    expect(container).toBeDefined();
    // Same trace, container nested under execute.
    expect(container.spanContext().traceId).toBe(execute.spanContext().traceId);
    expect(container.parentSpanContext?.spanId).toBe(execute.spanContext().spanId);
    expect(execute.attributes["appstrate.run.id"]).toBe("run_test");
  });

  it("records run duration histogram + terminal counter + container spawn", async () => {
    recordRunDuration(1234, { status: "success" });
    recordRunTerminal({ status: "success" });
    recordContainerSpawn(50, { sidecar: true });
    await _forceFlushForTesting();

    const rms = metricExporter.getMetrics();
    const duration = findMetric(rms, "appstrate.run.duration");
    const terminal = findMetric(rms, "appstrate.run.terminal");
    const spawn = findMetric(rms, "appstrate.run.container_spawn");

    expect(duration).toBeDefined();
    expect(terminal).toBeDefined();
    expect(spawn).toBeDefined();

    const durationCount = duration!.dataPoints.reduce(
      (n, p) => n + (p.value as { count: number }).count,
      0,
    );
    expect(durationCount).toBe(1);
    // Durations are recorded in SECONDS — 1234ms → 1.234s (not raw ms, which
    // would overflow the SDK's default histogram buckets).
    const durationSum = duration!.dataPoints.reduce(
      (n, p) => n + (p.value as { sum: number }).sum,
      0,
    );
    expect(durationSum).toBeCloseTo(1.234, 6);
    const spawnSum = spawn!.dataPoints.reduce((n, p) => n + (p.value as { sum: number }).sum, 0);
    expect(spawnSum).toBeCloseTo(0.05, 6);

    const terminalTotal = terminal!.dataPoints.reduce((n, p) => n + (p.value as number), 0);
    expect(terminalTotal).toBe(1);
    expect(terminal!.dataPoints[0]?.attributes.status).toBe("success");
    expect(terminal!.dataPoints[0]?.attributes.error_code).toBe("none");
  });

  it("records container_spawn for both outcomes — error.type on failure only, clamped", async () => {
    recordContainerSpawn(50, { sidecar: true }); // success
    recordContainerSpawn(20, { sidecar: false, errorType: "boundary" }); // failure (known phase)
    recordContainerSpawn(30, { sidecar: true, errorType: "totally-made-up" }); // failure (clamped)
    await _forceFlushForTesting();

    const spawn = findMetric(metricExporter.getMetrics(), "appstrate.run.container_spawn");
    const dps = spawn!.dataPoints;

    // Per OTel semconv: the success point carries NO error.type, so clean
    // latency is filterable; failures carry a bounded one.
    const success = dps.find((p) => p.attributes["error.type"] === undefined);
    expect(success).toBeDefined();
    expect(success!.attributes.sidecar).toBe(true);

    const errTypes = new Set(
      dps.map((p) => p.attributes["error.type"]).filter((t) => t !== undefined),
    );
    expect(errTypes.has("boundary")).toBe(true);
    // An out-of-allowlist phase collapses to "other" — cardinality stays bounded.
    expect(errTypes.has("other")).toBe(true);
    expect(errTypes.has("totally-made-up")).toBe(false);
  });

  it("records llm.latency with semconv attrs — error.type on failure only", async () => {
    recordLlmLatency(300, { api_shape: "openai", status: 200 }); // success
    recordLlmLatency(150, { api_shape: "openai", status: 429 }); // upstream error reply
    recordLlmLatency(80, { api_shape: "anthropic" }); // no response → transport failure
    await _forceFlushForTesting();

    const llm = findMetric(metricExporter.getMetrics(), "appstrate.llm.latency");
    expect(llm).toBeDefined();
    const dps = llm!.dataPoints;

    // Success: status code recorded, NO error.type (clean latency filterable).
    const success = dps.find((p) => p.attributes["http.response.status_code"] === 200);
    expect(success).toBeDefined();
    expect(success!.attributes["error.type"]).toBeUndefined();
    expect(success!.attributes.api_shape).toBe("openai");

    // Upstream 4xx/5xx: error.type is the status code as a string (semconv
    // value for non-exception HTTP errors).
    const upstreamErr = dps.find((p) => p.attributes["http.response.status_code"] === 429);
    expect(upstreamErr).toBeDefined();
    expect(upstreamErr!.attributes["error.type"]).toBe("429");

    // Transport failure (no upstream response): semconv fallback `_OTHER`,
    // and no status-code attribute to fake.
    const transport = dps.find((p) => p.attributes["error.type"] === "_OTHER");
    expect(transport).toBeDefined();
    expect(transport!.attributes["http.response.status_code"]).toBeUndefined();

    // The legacy non-semconv labels are gone.
    for (const p of dps) {
      expect(p.attributes.outcome).toBeUndefined();
      expect(p.attributes.status_code).toBeUndefined();
    }
  });

  it("records the documents lifecycle counters (created tagged by purpose, others plain)", async () => {
    recordDocumentCreated({ purpose: "agent_output" });
    recordDocumentCreated({ purpose: "agent_output" });
    recordDocumentCreated({ purpose: "user_upload" });
    recordDocumentDeleted(3); // one batch delete of 3 rows
    recordDocumentDeleted(1); // one explicit delete
    recordDocumentQuotaRejection();
    recordDocumentPartialPublication();
    await _forceFlushForTesting();

    const rms = metricExporter.getMetrics();
    const created = findMetric(rms, "appstrate.documents.created");
    const deleted = findMetric(rms, "appstrate.documents.deleted");
    const quota = findMetric(rms, "appstrate.documents.quota_rejections");
    const partial = findMetric(rms, "appstrate.documents.partial_publications");

    expect(created).toBeDefined();
    expect(deleted).toBeDefined();
    expect(quota).toBeDefined();
    expect(partial).toBeDefined();

    // created splits into two data points by purpose (2 agent_output + 1 upload).
    const byPurpose = new Map(
      created!.dataPoints.map((p) => [p.attributes.purpose, p.value as number]),
    );
    expect(byPurpose.get("agent_output")).toBe(2);
    expect(byPurpose.get("user_upload")).toBe(1);

    // deleted counts ROWS: 3 + 1 = 4.
    const deletedTotal = deleted!.dataPoints.reduce((n, p) => n + (p.value as number), 0);
    expect(deletedTotal).toBe(4);

    const quotaTotal = quota!.dataPoints.reduce((n, p) => n + (p.value as number), 0);
    expect(quotaTotal).toBe(1);
    const partialTotal = partial!.dataPoints.reduce((n, p) => n + (p.value as number), 0);
    expect(partialTotal).toBe(1);
  });

  it("tags a span that ends in a throw with error.type = exception class name", async () => {
    class FlakyUpstreamError extends Error {}
    await expect(
      runWithSpan("llm.call", {}, async () => {
        throw new FlakyUpstreamError("upstream reset");
      }),
    ).rejects.toThrow("upstream reset");

    const span = spanExporter.getFinishedSpans().find((s) => s.name === "llm.call");
    expect(span).toBeDefined();
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.attributes["error.type"]).toBe("FlakyUpstreamError");
  });

  it("clamps the terminal error_code label to the bounded allowlist", async () => {
    // Known stable code passes through; an arbitrary runner string collapses to
    // "other" so the dimension's cardinality stays bounded.
    recordRunTerminal({ status: "failed", errorCode: "timeout" });
    recordRunTerminal({ status: "failed", errorCode: "totally-made-up-code" });
    await _forceFlushForTesting();

    const terminal = findMetric(metricExporter.getMetrics(), "appstrate.run.terminal");
    const codes = new Set(terminal!.dataPoints.map((p) => p.attributes.error_code));
    expect(codes.has("timeout")).toBe(true);
    expect(codes.has("other")).toBe(true);
    expect(codes.has("totally-made-up-code")).toBe(false);
  });

  it("flows trace_id from an inbound traceparent into the span AND the logger context", async () => {
    const traceId = "0af7651916cd43dd8448eb211c80319c";
    const traceparent = `00-${traceId}-b7ad6b7169203331-01`;

    let loggerTraceId: string | undefined;
    let activeSpanTraceId: string | undefined;

    await runWithSpan("HTTP GET /x", { traceparent }, async () => {
      loggerTraceId = getTraceContext()?.traceId;
      activeSpanTraceId = currentSpan()?.spanContext().traceId;
    });

    expect(loggerTraceId).toBe(traceId);
    expect(activeSpanTraceId).toBe(traceId);

    const finished = spanExporter.getFinishedSpans().find((s) => s.name === "HTTP GET /x");
    expect(finished?.spanContext().traceId).toBe(traceId);
    // The span is a child of the remote inbound span.
    expect(finished?.parentSpanContext?.spanId).toBe("b7ad6b7169203331");
  });

  // The scheduler queue-depth observable gauge pulls its value from the
  // registered provider on each metric collection (forceFlush triggers one).
  // Covers the async-provider, non-finite-guard, and provider-throws branches
  // of the gauge callback in createInstruments().
  it("observes the queue depth from the registered provider (sync + async)", async () => {
    setQueueDepthProvider(() => 7);
    await _forceFlushForTesting();
    let gauge = findMetric(metricExporter.getMetrics(), "appstrate.scheduler.queue_depth");
    expect(gauge).toBeDefined();
    expect(gauge!.dataPoints.at(-1)?.value).toBe(7);

    // An async provider resolves before the observation is recorded.
    metricExporter.reset();
    setQueueDepthProvider(async () => 3);
    await _forceFlushForTesting();
    gauge = findMetric(metricExporter.getMetrics(), "appstrate.scheduler.queue_depth");
    expect(gauge!.dataPoints.at(-1)?.value).toBe(3);
  });

  it("does not observe a non-finite queue-depth reading", async () => {
    setQueueDepthProvider(() => Number.NaN);
    await _forceFlushForTesting();
    const gauge = findMetric(metricExporter.getMetrics(), "appstrate.scheduler.queue_depth");
    // NaN is rejected by the finite-guard → no data point emitted.
    expect(gauge?.dataPoints.length ?? 0).toBe(0);
  });

  it("a throwing queue-depth provider does not break metric collection", async () => {
    setQueueDepthProvider(() => {
      throw new Error("queue read failed");
    });
    // A sibling metric recorded in the same collection must still survive.
    recordRunTerminal({ status: "success" });
    await _forceFlushForTesting();

    const rms = metricExporter.getMetrics();
    const gauge = findMetric(rms, "appstrate.scheduler.queue_depth");
    const terminal = findMetric(rms, "appstrate.run.terminal");
    expect(gauge?.dataPoints.length ?? 0).toBe(0);
    expect(terminal).toBeDefined();
    expect(terminal!.dataPoints.reduce((n, p) => n + (p.value as number), 0)).toBe(1);
  });
});
