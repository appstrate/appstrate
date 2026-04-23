// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { createReducerSink } from "../../src/sinks/reducer-sink.ts";
import type { RunEvent } from "../../src/types/run-event.ts";
import { emptyRunResult, reduceEvents } from "../../src/runner/reducer.ts";

const RUN_ID = "run_test";

function event(type: string, extra: Record<string, unknown> = {}): RunEvent {
  return { type, timestamp: 0, runId: RUN_ID, ...extra };
}

describe("createReducerSink", () => {
  it("snapshot() returns emptyRunResult before any events", () => {
    const { snapshot } = createReducerSink();
    expect(snapshot()).toEqual(emptyRunResult());
  });

  it("folds memory.added incrementally", async () => {
    const { sink, snapshot } = createReducerSink();
    await sink.handle(event("memory.added", { content: "a" }));
    await sink.handle(event("memory.added", { content: "b" }));
    expect(snapshot().memories).toEqual([{ content: "a" }, { content: "b" }]);
  });

  it("tracks the last state.set value", async () => {
    const { sink, snapshot } = createReducerSink();
    await sink.handle(event("state.set", { state: { a: 1 } }));
    await sink.handle(event("state.set", { state: { b: 2 } }));
    expect(snapshot().state).toEqual({ b: 2 });
  });

  it("replaces output on each output.emitted event", async () => {
    const { sink, snapshot } = createReducerSink();
    await sink.handle(event("output.emitted", { data: { x: 1 } }));
    await sink.handle(event("output.emitted", { data: { y: 2 } }));
    expect(snapshot().output).toEqual({ y: 2 });

    await sink.handle(event("output.emitted", { data: [1, 2, 3] }));
    expect(snapshot().output).toEqual([1, 2, 3]);
  });

  it("concatenates report.appended with \\n", async () => {
    const { sink, snapshot } = createReducerSink();
    await sink.handle(event("report.appended", { content: "line one" }));
    await sink.handle(event("report.appended", { content: "line two" }));
    expect(snapshot().report).toBe("line one\nline two");
  });

  it("captures log.written entries", async () => {
    const { sink, snapshot } = createReducerSink();
    await sink.handle(event("log.written", { level: "info", message: "booting" }));
    await sink.handle(event("log.written", { level: "warn", message: "retry" }));
    expect(snapshot().logs).toEqual([
      { level: "info", message: "booting", timestamp: 0 },
      { level: "warn", message: "retry", timestamp: 0 },
    ]);
  });

  it("ignores third-party event types in the snapshot", async () => {
    const { sink, snapshot } = createReducerSink();
    await sink.handle(event("custom.thing", { payload: 42 }));
    expect(snapshot()).toEqual(emptyRunResult());
  });

  it("finalize() replaces the snapshot with the runner-provided result", async () => {
    const { sink, snapshot } = createReducerSink();
    await sink.handle(event("memory.added", { content: "a" }));
    const runnerResult = reduceEvents([
      event("memory.added", { content: "final" }),
      event("output.emitted", { data: { done: true } }),
    ]);
    await sink.finalize(runnerResult);
    expect(snapshot()).toBe(runnerResult);
  });

  it("produces the same result as reduceEvents over the event stream", async () => {
    const events = [
      event("memory.added", { content: "m1" }),
      event("state.set", { state: { c: 1 } }),
      event("output.emitted", { data: { a: 1 } }),
      event("output.emitted", { data: { b: 2 } }),
      event("report.appended", { content: "part one" }),
      event("report.appended", { content: "part two" }),
      event("log.written", { level: "info", message: "done" }),
    ];
    const { sink, snapshot } = createReducerSink();
    for (const ev of events) {
      await sink.handle(ev);
    }
    expect(snapshot()).toEqual(reduceEvents(events));
  });
});
