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
  _resetObservabilityForTesting,
  _forceFlushForTesting,
} from "../../src/observability/otel.ts";

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
});
