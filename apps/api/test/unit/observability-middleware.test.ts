// SPDX-License-Identifier: Apache-2.0

/**
 * Server-span middleware unit tests. Drives real requests through the
 * `observability()` middleware on a tiny Hono app (mirroring the production
 * wiring: a global `app.onError` + a wildcard `app.use`), and asserts the
 * emitted SERVER span via the in-memory exporter.
 *
 * Guards the deep-review regressions:
 *   - Route grouping: the span is named `<METHOD> <template>` and `http.route`
 *     carries the matched template (`/x/:id`), NOT the wildcard `/*` (the bug)
 *     nor the raw high-cardinality path.
 *   - 5xx status: a route error swallowed by `app.onError` still flips the
 *     SERVER span status to ERROR (runWithSpan's exception path never fires
 *     because `await next()` resolves normally once onError caught the throw).
 *
 * The route-template assertions FAIL against the pre-fix middleware (which read
 * `c.req.routePath` before `next()`, yielding `/*`) and PASS after.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import type { Context } from "hono";
import { SpanStatusCode, SpanKind } from "@opentelemetry/api";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} from "@opentelemetry/sdk-metrics";
import {
  initObservability,
  runWithSpan,
  _resetObservabilityForTesting,
  _forceFlushForTesting,
} from "../../src/observability/otel.ts";
import { observability } from "../../src/observability/middleware.ts";
import { runTraceparent } from "../../src/routes/runs.ts";
import { _resetCacheForTesting } from "@appstrate/env";
import { parseTraceparent } from "@appstrate/afps-runtime/transport";
import type { AppEnv } from "../../src/types/index.ts";

const INBOUND_TRACE_ID = "a".repeat(32);
const INBOUND_TRACEPARENT = `00-${INBOUND_TRACE_ID}-${"b".repeat(16)}-01`;

/** Minimal Hono context exposing only `get("traceparent")` for the gate test. */
function fakeContext(traceparent?: string): Context<AppEnv> {
  return {
    get: (key: string) => (key === "traceparent" ? traceparent : undefined),
  } as unknown as Context<AppEnv>;
}

function buildApp() {
  const app = new Hono<AppEnv>();
  // Mirror production: global error hook converts thrown route errors into a
  // 500 response, so the wildcard middleware's `await next()` resolves normally.
  app.onError((_err, c) => c.json({ error: "boom" }, 500));
  app.use("*", observability());
  app.get("/x/:id", (c) => c.text("ok"));
  app.get("/boom", () => {
    throw new Error("kaboom");
  });
  return app;
}

function findSpan(exporter: InMemorySpanExporter, name: string): ReadableSpan | undefined {
  return exporter.getFinishedSpans().find((s) => s.name === name);
}

describe("observability() middleware", () => {
  let spanExporter: InMemorySpanExporter;

  beforeEach(async () => {
    await _resetObservabilityForTesting();
    spanExporter = new InMemorySpanExporter();
    await initObservability({
      enabled: true,
      spanExporter,
      // In-memory metric reader so init never reaches for a real OTLP exporter.
      metricReader: new PeriodicExportingMetricReader({
        exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
        exportIntervalMillis: 100_000,
      }),
    });
  });

  afterEach(async () => {
    await _resetObservabilityForTesting();
  });

  it("names the SERVER span with the matched route template, not the wildcard", async () => {
    const app = buildApp();
    const res = await app.request("/x/123");
    expect(res.status).toBe(200);
    await _forceFlushForTesting();

    const span = findSpan(spanExporter, "GET /x/:id");
    expect(span).toBeDefined();
    // http.route is the low-cardinality template, not the raw path.
    expect(span!.attributes["http.route"]).toBe("/x/:id");
    expect(span!.attributes["url.path"]).toBe("/x/123");
    expect(span!.attributes["http.response.status_code"]).toBe(200);
    // No raw `/*` wildcard span leaked.
    expect(findSpan(spanExporter, "GET /*")).toBeUndefined();
  });

  it("sets ERROR span status on a 5xx swallowed by app.onError", async () => {
    const app = buildApp();
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    await _forceFlushForTesting();

    const span = findSpan(spanExporter, "GET /boom");
    expect(span).toBeDefined();
    expect(span!.attributes["http.response.status_code"]).toBe(500);
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("names an unmatched (404) span with the method alone, keeping url.path", async () => {
    const app = buildApp();
    const res = await app.request("/no/such/route");
    expect(res.status).toBe(404);
    await _forceFlushForTesting();

    // No low-cardinality route resolves → span name is just `{method}` (OTel
    // HTTP semconv). The raw path is NEVER in the name (scanners spraying paths
    // would otherwise explode span-name cardinality); it stays in `url.path`.
    const span = findSpan(spanExporter, "GET");
    expect(span).toBeDefined();
    expect(span!.attributes["http.route"]).toBeUndefined();
    expect(span!.attributes["url.path"]).toBe("/no/such/route");
    // The raw path never leaked into the span name.
    expect(findSpan(spanExporter, "GET /no/such/route")).toBeUndefined();
  });
});

/**
 * `runTraceparent()` is the run-path counterpart of the SERVER-span trust gate:
 * it decides which traceparent seeds the run-execution trace tree. With
 * `OTEL_TRUST_INCOMING_TRACE` off (default), an unverified inbound header must
 * NOT become the run's trace — the run links to the in-process SERVER span
 * instead (or starts fresh). With the flag on, the inbound header is adopted.
 */
describe("runTraceparent() trust gate", () => {
  beforeEach(async () => {
    await _resetObservabilityForTesting();
    await initObservability({
      enabled: true,
      spanExporter: new InMemorySpanExporter(),
      metricReader: new PeriodicExportingMetricReader({
        exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
        exportIntervalMillis: 100_000,
      }),
    });
  });

  afterEach(async () => {
    await _resetObservabilityForTesting();
    delete process.env.OTEL_TRUST_INCOMING_TRACE;
    _resetCacheForTesting();
  });

  it("does NOT adopt the inbound trace_id when trust is off", async () => {
    process.env.OTEL_TRUST_INCOMING_TRACE = "false";
    _resetCacheForTesting();

    // Mirror the trust-off SERVER span: a fresh root (NOT parented from the
    // inbound header). Inside it, the run path resolves its traceparent.
    let resolved: string | undefined;
    let serverTraceId: string | undefined;
    await runWithSpan("GET /api/agents/:scope/:name/run", { kind: SpanKind.SERVER }, async () => {
      serverTraceId = parseTraceparent(
        // the active SERVER span's own traceparent, via the gate's fallback
        runTraceparent(fakeContext(undefined)),
      )?.traceId;
      resolved = runTraceparent(fakeContext(INBOUND_TRACEPARENT));
    });

    const resolvedTraceId = parseTraceparent(resolved)?.traceId;
    // The run span links to the in-process SERVER span, never the inbound id.
    expect(resolvedTraceId).toBeDefined();
    expect(resolvedTraceId).not.toBe(INBOUND_TRACE_ID);
    expect(resolvedTraceId).toBe(serverTraceId);
  });

  it("adopts the inbound traceparent verbatim when trust is on", () => {
    process.env.OTEL_TRUST_INCOMING_TRACE = "true";
    _resetCacheForTesting();

    expect(runTraceparent(fakeContext(INBOUND_TRACEPARENT))).toBe(INBOUND_TRACEPARENT);
  });
});
