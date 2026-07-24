// SPDX-License-Identifier: Apache-2.0

/**
 * Core telemetry façade unit tests — provider-agnostic, no OTel anywhere.
 *
 * Proves the two façade guarantees the module extraction rests on:
 *   (a) WITHOUT a provider (observability module absent) every helper is a
 *       true no-op: `runWithSpan` is `return fn()`, recorders are inert,
 *       `runTraceparent` never trusts an inbound header, the global
 *       middleware is a straight pass-through;
 *   (b) WITH a provider installed, every core call site delegates faithfully
 *       — including the queue-depth source registered BEFORE install (the
 *       scheduler may start before module init) being replayed on install.
 *
 * The OTel implementation itself is covered in
 * `packages/module-observability/test/`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import type { Context } from "hono";
import {
  installTelemetryProvider,
  _resetTelemetryForTesting,
  runWithSpan,
  currentTraceparent,
  telemetryTrustsIncomingTrace,
  recordRunDuration,
  recordRunTerminal,
  recordContainerSpawn,
  recordLlmLatency,
  recordProcessAnomaly,
  setQueueDepthSource,
  shutdownTelemetry,
  type QueueDepthSource,
  type TelemetryProvider,
} from "@appstrate/core/telemetry";
import { telemetry } from "../../src/middleware/telemetry.ts";
import { runTraceparent } from "../../src/routes/runs.ts";
import type { AppEnv } from "../../src/types/index.ts";

const INBOUND_TRACEPARENT = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`;

/** Minimal Hono context exposing only `get("traceparent")` for the gate test. */
function fakeContext(traceparent?: string): Context<AppEnv> {
  return {
    get: (key: string) => (key === "traceparent" ? traceparent : undefined),
  } as unknown as Context<AppEnv>;
}

/** Recording fake provider — no telemetry SDK involved. */
function fakeProvider(opts: { trust?: boolean; withMiddleware?: boolean } = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let queueSource: QueueDepthSource | undefined;
  const provider: TelemetryProvider = {
    runWithSpan: (name, spanOpts, fn) => {
      calls.push({ method: "runWithSpan", args: [name, spanOpts] });
      return fn();
    },
    currentTraceparent: () => "00-provider-traceparent-01",
    trustsIncomingTrace: () => opts.trust ?? false,
    recordRunDuration: (...args) => void calls.push({ method: "recordRunDuration", args }),
    recordRunTerminal: (...args) => void calls.push({ method: "recordRunTerminal", args }),
    recordContainerSpawn: (...args) => void calls.push({ method: "recordContainerSpawn", args }),
    recordLlmLatency: (...args) => void calls.push({ method: "recordLlmLatency", args }),
    recordProcessAnomaly: (...args) => void calls.push({ method: "recordProcessAnomaly", args }),
    recordStorageDeletionSweep: (...args) =>
      void calls.push({ method: "recordStorageDeletionSweep", args }),
    recordStorageDeletionResult: (...args) =>
      void calls.push({ method: "recordStorageDeletionResult", args }),
    setQueueDepthSource: (source) => {
      queueSource = source;
    },
    ...(opts.withMiddleware
      ? {
          httpMiddleware: async (c: Context, next: () => Promise<void>) => {
            calls.push({ method: "httpMiddleware", args: [c.req.path] });
            await next();
          },
        }
      : {}),
    shutdown: async () => void calls.push({ method: "shutdown", args: [] }),
  };
  return { provider, calls, queueSource: () => queueSource };
}

beforeEach(() => {
  _resetTelemetryForTesting();
});

afterEach(() => {
  _resetTelemetryForTesting();
});

describe("telemetry façade — no provider (module absent)", () => {
  it("runWithSpan calls fn directly and returns its value", async () => {
    const result = await runWithSpan("noop.span", { attributes: { k: "v" } }, async () => 42);
    expect(result).toBe(42);
  });

  it("currentTraceparent is undefined; recorders + shutdown are inert", async () => {
    expect(currentTraceparent()).toBeUndefined();
    expect(() => recordRunDuration(5, { status: "success" })).not.toThrow();
    expect(() => recordRunTerminal({ status: "failed", errorCode: "timeout" })).not.toThrow();
    expect(() => recordContainerSpawn(10, { sidecar: true })).not.toThrow();
    expect(() => recordLlmLatency(5, { api_shape: "openai", status: 200 })).not.toThrow();
    expect(() => recordProcessAnomaly({ kind: "uncaughtException" })).not.toThrow();
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });

  it("never trusts an inbound traceparent — runTraceparent returns undefined", () => {
    expect(telemetryTrustsIncomingTrace()).toBe(false);
    expect(runTraceparent(fakeContext(INBOUND_TRACEPARENT))).toBeUndefined();
  });

  it("the global telemetry middleware is a pass-through", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", telemetry());
    app.get("/x", (c) => c.text("ok"));
    const res = await app.request("/x");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

describe("telemetry façade — provider installed", () => {
  it("delegates spans + recorders with the exact arguments", async () => {
    const { provider, calls } = fakeProvider();
    installTelemetryProvider(provider);

    const result = runWithSpan(
      "appstrate.run.gates",
      { attributes: { "appstrate.run.id": "run_1" } },
      () => "done",
    );
    expect(result).toBe("done");
    recordLlmLatency(300, { api_shape: "openai", status: 429 });
    recordRunTerminal({ status: "failed", errorCode: "timeout" });

    expect(calls).toEqual([
      {
        method: "runWithSpan",
        args: ["appstrate.run.gates", { attributes: { "appstrate.run.id": "run_1" } }],
      },
      { method: "recordLlmLatency", args: [300, { api_shape: "openai", status: 429 }] },
      { method: "recordRunTerminal", args: [{ status: "failed", errorCode: "timeout" }] },
    ]);
    expect(currentTraceparent()).toBe("00-provider-traceparent-01");
  });

  it("replays a queue-depth source registered BEFORE the provider install", () => {
    const source = () => 7;
    setQueueDepthSource(source); // scheduler boots first
    const { provider, queueSource } = fakeProvider();
    installTelemetryProvider(provider); // module init comes later
    expect(queueSource()).toBe(source);
  });

  it("forwards a queue-depth source registered AFTER install", () => {
    const { provider, queueSource } = fakeProvider();
    installTelemetryProvider(provider);
    const source = () => 3;
    setQueueDepthSource(source);
    expect(queueSource()).toBe(source);
  });

  it("runTraceparent adopts the inbound header only when the provider trusts it", () => {
    const trusted = fakeProvider({ trust: true });
    installTelemetryProvider(trusted.provider);
    expect(runTraceparent(fakeContext(INBOUND_TRACEPARENT))).toBe(INBOUND_TRACEPARENT);

    const untrusted = fakeProvider({ trust: false });
    installTelemetryProvider(untrusted.provider);
    // Falls back to the provider's in-process traceparent, never the header.
    expect(runTraceparent(fakeContext(INBOUND_TRACEPARENT))).toBe("00-provider-traceparent-01");
  });

  it("the global middleware delegates to the provider's httpMiddleware per request", async () => {
    const app = new Hono<AppEnv>();
    // Registered BEFORE the provider exists — mirrors production ordering
    // (app wiring, then module init during boot()).
    app.use("*", telemetry());
    app.get("/x", (c) => c.text("ok"));

    const { provider, calls } = fakeProvider({ withMiddleware: true });
    installTelemetryProvider(provider);

    const res = await app.request("/x");
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ method: "httpMiddleware", args: ["/x"] }]);
  });

  it("shutdownTelemetry delegates to the provider", async () => {
    const { provider, calls } = fakeProvider();
    installTelemetryProvider(provider);
    await shutdownTelemetry();
    expect(calls).toEqual([{ method: "shutdown", args: [] }]);
  });
});
