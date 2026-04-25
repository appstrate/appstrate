// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  memoryTool,
  checkpointTool,
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

  it("checkpointTool emits checkpoint.set with data + default scope omitted", async () => {
    const { ctx, events } = makeCtx();
    await checkpointTool.execute({ data: { step: 7 } }, ctx);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("checkpoint.set");
    expect(events[0]!.data).toEqual({ step: 7 });
    expect(events[0]!.scope).toBeUndefined();
  });

  it("checkpointTool propagates scope when set to 'shared'", async () => {
    const { ctx, events } = makeCtx();
    await checkpointTool.execute({ data: { cursor: "abc" }, scope: "shared" }, ctx);
    expect(events[0]!.type).toBe("checkpoint.set");
    expect(events[0]!.scope).toBe("shared");
  });

  it("memoryTool propagates scope when explicitly set", async () => {
    const { ctx, events } = makeCtx();
    await memoryTool.execute({ content: "preference: CSV", scope: "actor" }, ctx);
    expect(events[0]!.type).toBe("memory.added");
    expect(events[0]!.scope).toBe("actor");
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

  it("PLATFORM_TOOLS maps all canonical tool names", () => {
    expect(Object.keys(PLATFORM_TOOLS).sort()).toEqual(
      ["add_memory", "log", "output", "report", "set_checkpoint"].sort(),
    );
    expect(PLATFORM_TOOLS.add_memory).toBe(memoryTool);
    expect(PLATFORM_TOOLS.set_checkpoint).toBe(checkpointTool);
    expect(PLATFORM_TOOLS.log).toBe(logTool);
  });
});

describe("checkpoint.set fold semantics", () => {
  it("reducer folds checkpoint.set into result.checkpoint with scope captured", () => {
    const events: RunEvent[] = [
      {
        type: "checkpoint.set",
        timestamp: 1,
        runId: "r",
        data: { cursor: "abc" },
        scope: "shared",
      },
    ];
    const result = reduceEvents(events);
    expect(result.checkpoint).toEqual({ cursor: "abc" });
    expect(result.checkpointScope).toBe("shared");
  });

  it("reducer last-write-wins across multiple checkpoint.set events", () => {
    const events: RunEvent[] = [
      { type: "checkpoint.set", timestamp: 1, runId: "r", data: { v: 1 } },
      { type: "checkpoint.set", timestamp: 2, runId: "r", data: { v: 2 }, scope: "actor" },
    ];
    const result = reduceEvents(events);
    expect(result.checkpoint).toEqual({ v: 2 });
    expect(result.checkpointScope).toBe("actor");
  });

  it("reducer captures memory.added scope when present, leaves undefined otherwise", () => {
    const events: RunEvent[] = [
      { type: "memory.added", timestamp: 1, runId: "r", content: "no-scope" },
      { type: "memory.added", timestamp: 2, runId: "r", content: "scoped", scope: "shared" },
    ];
    const result = reduceEvents(events);
    expect(result.memories).toEqual([
      { content: "no-scope" },
      { content: "scoped", scope: "shared" },
    ]);
  });
});

describe("reduceEvents", () => {
  it("reduces a canonical mix into the aggregated RunResult", () => {
    const base = { runId: "r" };
    const events: RunEvent[] = [
      { ...base, type: "memory.added", timestamp: 1, content: "a" },
      { ...base, type: "memory.added", timestamp: 2, content: "b" },
      { ...base, type: "checkpoint.set", timestamp: 3, data: { x: 1 } },
      { ...base, type: "output.emitted", timestamp: 4, data: { a: 1 } },
      { ...base, type: "output.emitted", timestamp: 5, data: { b: 2 } },
      { ...base, type: "report.appended", timestamp: 6, content: "line 1" },
      { ...base, type: "report.appended", timestamp: 7, content: "line 2" },
      { ...base, type: "log.written", timestamp: 8, level: "info", message: "hello" },
    ];
    const result = reduceEvents(events);
    expect(result.memories).toEqual([{ content: "a" }, { content: "b" }]);
    expect(result.checkpoint).toEqual({ x: 1 });
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
