// SPDX-License-Identifier: Apache-2.0

/**
 * Server-span middleware unit tests. Drives real requests through the
 * `observability()` middleware on a tiny Hono app (mirroring the production
 * wiring: a global `app.onError` + a wildcard `app.use`), and asserts the
 * emitted SERVER span via the in-memory exporter.
 *
 * The client-IP resolver is INJECTED (in production the module receives
 * `ctx.services.http.clientIp` at init) — tests pass a stub, so the
 * TRUST_PROXY resolution semantics themselves stay covered platform-side
 * where the resolver lives.
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
import { SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} from "@opentelemetry/sdk-metrics";
import {
  initObservability,
  _resetObservabilityForTesting,
  _forceFlushForTesting,
} from "../src/otel.ts";
import { observability } from "../src/middleware.ts";

/** Stub resolver — the "nothing resolves" sentinel unless a test overrides it. */
const unknownClientIp = (_c: Context) => "unknown";

function buildApp(clientIp: (c: Context) => string = unknownClientIp) {
  const app = new Hono();
  // Mirror production: global error hook converts thrown route errors into a
  // 500 response, so the wildcard middleware's `await next()` resolves normally.
  app.onError((_err, c) => c.json({ error: "boom" }, 500));
  app.use("*", observability({ clientIp }));
  app.get("/x/:id", (c) => c.text("ok"));
  app.get("/boom", () => {
    throw new Error("kaboom");
  });
  // A handler that RETURNS a 5xx without throwing — no exception ever reaches
  // app.onError, so `c.error` stays unset.
  app.get("/fail", (c) => c.json({ error: "deliberate" }, 503));
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

  it("carries the OTel HTTP semconv request attributes", async () => {
    const app = buildApp();
    const res = await app.request("/x/123");
    expect(res.status).toBe(200);
    await _forceFlushForTesting();

    const span = findSpan(spanExporter, "GET /x/:id");
    expect(span).toBeDefined();
    // `url.scheme` is Required by semconv; `server.address` is the Host the
    // client targeted (Hono's test harness builds http://localhost/...).
    expect(span!.attributes["url.scheme"]).toBe("http");
    expect(span!.attributes["server.address"]).toBe("localhost");
    // Resolver returned the "unknown" sentinel → the attribute is OMITTED,
    // never recorded verbatim.
    expect(span!.attributes["client.address"]).toBeUndefined();
    // Success: no error.type.
    expect(span!.attributes["error.type"]).toBeUndefined();
  });

  it("sets client.address from the injected resolver when it resolves", async () => {
    const app = buildApp(() => "203.0.113.9");
    const res = await app.request("/x/1");
    expect(res.status).toBe(200);
    await _forceFlushForTesting();

    const span = findSpan(spanExporter, "GET /x/:id");
    expect(span).toBeDefined();
    expect(span!.attributes["client.address"]).toBe("203.0.113.9");
  });

  it("sets ERROR span status + exception-class error.type on a 5xx swallowed by app.onError", async () => {
    const app = buildApp();
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    await _forceFlushForTesting();

    const span = findSpan(spanExporter, "GET /boom");
    expect(span).toBeDefined();
    expect(span!.attributes["http.response.status_code"]).toBe(500);
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    // The throw was caught by app.onError (Hono stashes it on c.error) — per
    // semconv, error.type is the exception class name.
    expect(span!.attributes["error.type"]).toBe("Error");
  });

  it("sets the status code as error.type on a returned (non-thrown) 5xx", async () => {
    const app = buildApp();
    const res = await app.request("/fail");
    expect(res.status).toBe(503);
    await _forceFlushForTesting();

    const span = findSpan(spanExporter, "GET /fail");
    expect(span).toBeDefined();
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    // No exception escaped → semconv falls back to the status code as string.
    expect(span!.attributes["error.type"]).toBe("503");
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

  it("does not adopt the inbound traceparent when trust is off (default)", async () => {
    delete process.env.OTEL_TRUST_INCOMING_TRACE;
    const app = buildApp();
    const inboundTraceId = "a".repeat(32);
    const res = await app.request("/x/1", {
      headers: { traceparent: `00-${inboundTraceId}-${"b".repeat(16)}-01` },
    });
    expect(res.status).toBe(200);
    await _forceFlushForTesting();

    const span = findSpan(spanExporter, "GET /x/:id");
    expect(span).toBeDefined();
    // Fresh root — the unverified inbound header never becomes the trace.
    expect(span!.spanContext().traceId).not.toBe(inboundTraceId);
    expect(span!.parentSpanContext).toBeUndefined();
  });

  it("adopts the inbound traceparent when OTEL_TRUST_INCOMING_TRACE=true", async () => {
    process.env.OTEL_TRUST_INCOMING_TRACE = "true";
    try {
      const app = buildApp();
      const inboundTraceId = "a".repeat(32);
      const inboundSpanId = "b".repeat(16);
      const res = await app.request("/x/1", {
        headers: { traceparent: `00-${inboundTraceId}-${inboundSpanId}-01` },
      });
      expect(res.status).toBe(200);
      await _forceFlushForTesting();

      const span = findSpan(spanExporter, "GET /x/:id");
      expect(span).toBeDefined();
      expect(span!.spanContext().traceId).toBe(inboundTraceId);
      expect(span!.parentSpanContext?.spanId).toBe(inboundSpanId);
    } finally {
      delete process.env.OTEL_TRUST_INCOMING_TRACE;
    }
  });
});
