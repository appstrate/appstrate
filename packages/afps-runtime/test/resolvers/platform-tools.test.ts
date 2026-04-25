// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  memoryTool,
  stateTool,
  outputTool,
  reportTool,
  logTool,
  PLATFORM_TOOLS,
  type RunEvent,
  type ToolContext,
} from "../../src/resolvers/index.ts";
import { reduceEvents } from "../../src/runner/index.ts";

function makeCtx(): { ctx: ToolContext; events: RunEvent[] } {
  const events: RunEvent[] = [];
  return {
    events,
    ctx: {
      emit: (e) => {
        events.push(e);
      },
      workspace: "/tmp",
      runId: "run_x",
      toolCallId: "call_1",
      signal: new AbortController().signal,
    },
  };
}

describe("platform tools — open envelope emission", () => {
  it("memoryTool emits memory.added with content", async () => {
    const { ctx, events } = makeCtx();
    await memoryTool.execute({ content: "remember me" }, ctx);
    expect(events).toEqual([
      expect.objectContaining({
        type: "memory.added",
        runId: "run_x",
        toolCallId: "call_1",
        content: "remember me",
      }),
    ]);
  });

  it("stateTool emits state.set with arbitrary payload", async () => {
    const { ctx, events } = makeCtx();
    await stateTool.execute({ state: { step: 3 } }, ctx);
    expect(events[0]!.type).toBe("state.set");
    expect(events[0]!.state).toEqual({ step: 3 });
  });

  it("outputTool emits output.emitted", async () => {
    const { ctx, events } = makeCtx();
    await outputTool.execute({ data: { ok: true } }, ctx);
    expect(events[0]!.type).toBe("output.emitted");
    expect(events[0]!.data).toEqual({ ok: true });
  });

  it("reportTool emits report.appended", async () => {
    const { ctx, events } = makeCtx();
    await reportTool.execute({ content: "done" }, ctx);
    expect(events[0]!.type).toBe("report.appended");
    expect(events[0]!.content).toBe("done");
  });

  it("logTool emits log.written with level + message", async () => {
    const { ctx, events } = makeCtx();
    await logTool.execute({ level: "warn", message: "slow" }, ctx);
    expect(events[0]!.type).toBe("log.written");
    expect(events[0]!.level).toBe("warn");
    expect(events[0]!.message).toBe("slow");
  });

  it("PLATFORM_TOOLS maps all five canonical tool names", () => {
    expect(Object.keys(PLATFORM_TOOLS).sort()).toEqual(
      ["add_memory", "log", "output", "report", "set_state"].sort(),
    );
    expect(PLATFORM_TOOLS.add_memory).toBe(memoryTool);
    expect(PLATFORM_TOOLS.log).toBe(logTool);
  });
});

describe("reduceEvents", () => {
  it("reduces a canonical mix into the aggregated RunResult", () => {
    const base = { runId: "r" };
    const events: RunEvent[] = [
      { ...base, type: "memory.added", timestamp: 1, content: "a" },
      { ...base, type: "memory.added", timestamp: 2, content: "b" },
      { ...base, type: "state.set", timestamp: 3, state: { x: 1 } },
      { ...base, type: "output.emitted", timestamp: 4, data: { a: 1 } },
      { ...base, type: "output.emitted", timestamp: 5, data: { b: 2 } },
      { ...base, type: "report.appended", timestamp: 6, content: "line 1" },
      { ...base, type: "report.appended", timestamp: 7, content: "line 2" },
      { ...base, type: "log.written", timestamp: 8, level: "info", message: "hello" },
    ];
    const result = reduceEvents(events);
    expect(result.memories).toEqual([{ content: "a" }, { content: "b" }]);
    expect(result.state).toEqual({ x: 1 });
    expect(result.output).toEqual({ b: 2 });
    expect(result.report).toBe("line 1\nline 2");
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]!.timestamp).toBe(8);
  });

  it("ignores third-party event types (does not crash)", () => {
    const events: RunEvent[] = [
      { type: "@my/audit.logged", timestamp: 1, runId: "r", what: "x" },
      { type: "memory.added", timestamp: 2, runId: "r", content: "kept" },
    ];
    const result = reduceEvents(events);
    expect(result.memories).toEqual([{ content: "kept" }]);
  });
});
