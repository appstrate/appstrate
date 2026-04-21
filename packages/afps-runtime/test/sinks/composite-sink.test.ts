// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { CompositeSink } from "../../src/sinks/composite-sink.ts";
import type { EventSink } from "../../src/interfaces/event-sink.ts";
import type { RunEvent } from "../../src/types/run-event.ts";
import type { RunResult } from "../../src/types/run-result.ts";

class RecordingSink implements EventSink {
  readonly events: RunEvent[] = [];
  finalizeResult: RunResult | null = null;
  handleError?: Error;
  finalizeError?: Error;

  async handle(event: RunEvent): Promise<void> {
    if (this.handleError) throw this.handleError;
    this.events.push(event);
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

function event(type: string, extra: Record<string, unknown> = {}): RunEvent {
  return { type, timestamp: 0, runId: "r", ...extra };
}

describe("CompositeSink", () => {
  it("broadcasts handle to every child", async () => {
    const a = new RecordingSink();
    const b = new RecordingSink();
    const composite = new CompositeSink([a, b]);

    const ev = event("memory.added", { content: "x" });
    await composite.handle(ev);

    expect(a.events).toEqual([ev]);
    expect(b.events).toEqual([ev]);
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
    b.handleError = new Error("boom");
    const c = new RecordingSink();
    const composite = new CompositeSink([a, b, c]);

    const ev = event("log.written", { level: "info", message: "x" });

    await expect(composite.handle(ev)).rejects.toThrow(/boom/);

    expect(a.events).toEqual([ev]);
    expect(c.events).toEqual([ev]);
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
    await composite.handle(event("log.written", { level: "info", message: "x" }));
    await composite.finalize(emptyResult);
  });
});
