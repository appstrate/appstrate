// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { CompositeSink } from "../../src/sinks/composite-sink.ts";
import type { EventSink } from "../../src/interfaces/event-sink.ts";
import type { AfpsEventEnvelope } from "../../src/types/afps-event.ts";
import type { RunResult } from "../../src/types/run-result.ts";

class RecordingSink implements EventSink {
  readonly events: AfpsEventEnvelope[] = [];
  finalizeResult: RunResult | null = null;
  onEventError?: Error;
  finalizeError?: Error;

  async onEvent(envelope: AfpsEventEnvelope): Promise<void> {
    if (this.onEventError) throw this.onEventError;
    this.events.push(envelope);
  }
  async finalize(result: RunResult): Promise<void> {
    if (this.finalizeError) throw this.finalizeError;
    this.finalizeResult = result;
  }
}

const emptyResult: RunResult = {
  memories: [],
  state: null,
  output: null,
  report: null,
  logs: [],
};

describe("CompositeSink", () => {
  it("broadcasts onEvent to every child", async () => {
    const a = new RecordingSink();
    const b = new RecordingSink();
    const composite = new CompositeSink([a, b]);

    const env: AfpsEventEnvelope = {
      runId: "r",
      sequence: 1,
      event: { type: "add_memory", content: "x" },
    };
    await composite.onEvent(env);

    expect(a.events).toEqual([env]);
    expect(b.events).toEqual([env]);
  });

  it("broadcasts finalize to every child", async () => {
    const a = new RecordingSink();
    const b = new RecordingSink();
    const composite = new CompositeSink([a, b]);

    await composite.finalize(emptyResult);

    expect(a.finalizeResult).toEqual(emptyResult);
    expect(b.finalizeResult).toEqual(emptyResult);
  });

  it("waits for every child even when one fails, then surfaces aggregate error", async () => {
    const a = new RecordingSink();
    const b = new RecordingSink();
    b.onEventError = new Error("boom");
    const c = new RecordingSink();
    const composite = new CompositeSink([a, b, c]);

    const env: AfpsEventEnvelope = {
      runId: "r",
      sequence: 1,
      event: { type: "log", level: "info", message: "x" },
    };

    await expect(composite.onEvent(env)).rejects.toThrow(/boom/);

    // healthy siblings still received the event
    expect(a.events).toEqual([env]);
    expect(c.events).toEqual([env]);
  });

  it("reports multiple failures in one aggregate error", async () => {
    const a = new RecordingSink();
    a.finalizeError = new Error("a-fail");
    const b = new RecordingSink();
    b.finalizeError = new Error("b-fail");
    const composite = new CompositeSink([a, b]);

    await expect(composite.finalize(emptyResult)).rejects.toThrow(
      /2 sink\(s\) failed.*a-fail.*b-fail/,
    );
  });

  it("works with zero children (no-op)", async () => {
    const composite = new CompositeSink([]);
    await composite.onEvent({
      runId: "r",
      sequence: 1,
      event: { type: "log", level: "info", message: "x" },
    });
    await composite.finalize(emptyResult);
  });
});
