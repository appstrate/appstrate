// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the `emitRuntimeReady` helper — the single-shot
 * progress signal that runtime-pi emits after the bundle is loaded
 * but before PiRunner's loop starts.
 */

import { describe, it, expect } from "bun:test";
import type { EventSink } from "@appstrate/afps-runtime/interfaces";
import type { RunEvent } from "@appstrate/afps-runtime/types";
import { CURRENT_RUNTIME_PROTOCOL_VERSION, emitRuntimeReady } from "../src/runtime-ready.ts";

function collectingSink(): { sink: EventSink; events: RunEvent[] } {
  const events: RunEvent[] = [];
  const sink: EventSink = {
    async handle(event) {
      events.push(event);
    },
    async finalize() {},
  };
  return { sink, events };
}

describe("emitRuntimeReady", () => {
  it("emits a single appstrate.progress event carrying the readiness marker", async () => {
    const { sink, events } = collectingSink();
    await emitRuntimeReady(
      sink,
      "run_abc",
      { bundleLoaded: true, extensions: 4, bootDurationMs: 1234 },
      () => 1_700_000_000_000,
    );

    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.type).toBe("appstrate.progress");
    expect(evt.runId).toBe("run_abc");
    expect(evt.timestamp).toBe(1_700_000_000_000);
    const raw = evt as unknown as Record<string, unknown>;
    expect(raw.message).toBe("runtime ready in 1234ms");
    expect(raw.level).toBe("info");
    expect(raw.data).toEqual({
      bundleLoaded: true,
      extensions: 4,
      runtimeProtocolVersion: CURRENT_RUNTIME_PROTOCOL_VERSION,
    });
  });

  it("defaults runtimeProtocolVersion to the current constant when caller omits it", async () => {
    const { sink, events } = collectingSink();
    await emitRuntimeReady(sink, "run_default", {
      bundleLoaded: true,
      extensions: 0,
      bootDurationMs: 1,
    });
    const raw = events[0]! as unknown as { data: { runtimeProtocolVersion: string } };
    expect(raw.data.runtimeProtocolVersion).toBe(CURRENT_RUNTIME_PROTOCOL_VERSION);
  });

  it("respects an explicit runtimeProtocolVersion override (forward-compat)", async () => {
    const { sink, events } = collectingSink();
    await emitRuntimeReady(sink, "run_override", {
      bundleLoaded: true,
      extensions: 0,
      bootDurationMs: 1,
      runtimeProtocolVersion: "1.0",
    });
    const raw = events[0]! as unknown as { data: { runtimeProtocolVersion: string } };
    expect(raw.data.runtimeProtocolVersion).toBe("1.0");
  });

  it("rounds fractional boot durations so the message stays integer-millisecond", async () => {
    const { sink, events } = collectingSink();
    await emitRuntimeReady(sink, "run_y", {
      bundleLoaded: true,
      extensions: 0,
      bootDurationMs: 12.7,
    });

    const raw = events[0]! as unknown as Record<string, unknown>;
    expect(raw.message).toBe("runtime ready in 13ms");
  });

  it("is NOT a run.started event — the webhook + openapi contracts stay untouched", async () => {
    const { sink, events } = collectingSink();
    await emitRuntimeReady(sink, "run_x", {
      bundleLoaded: false,
      extensions: 0,
      bootDurationMs: 0,
    });

    // `run.started` is a reserved public event type (Standard Webhooks
    // catalogue, openapi spec, onRunStatusChange consumers). Using
    // appstrate.progress keeps the readiness signal internal to the
    // log stream without polluting downstream contracts.
    expect(events[0]!.type).not.toBe("run.started");
    expect(events[0]!.type).toBe("appstrate.progress");
  });

  it("propagates sink errors so the entrypoint's bootstrap-error path can escalate", async () => {
    const failingSink: EventSink = {
      async handle() {
        throw new Error("HttpSink: retryable 500");
      },
      async finalize() {},
    };
    await expect(
      emitRuntimeReady(failingSink, "run_x", {
        bundleLoaded: false,
        extensions: 0,
        bootDurationMs: 0,
      }),
    ).rejects.toThrow(/retryable 500/);
  });
});
