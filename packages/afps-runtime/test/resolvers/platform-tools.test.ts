// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  noteTool,
  pinTool,
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
  it("noteTool emits memory.added with content", async () => {
    const { ctx, events } = makeCtx();
    await noteTool.execute({ content: "remember me" }, ctx);
    expect(events).toEqual([
      expect.objectContaining({
        type: "memory.added",
        runId: "run_x",
        toolCallId: "call_1",
        content: "remember me",
      }),
    ]);
  });

  it("pinTool emits pinned.set with key + content + default scope omitted", async () => {
    const { ctx, events } = makeCtx();
    await pinTool.execute({ key: "checkpoint", content: { step: 7 } }, ctx);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("pinned.set");
    expect(events[0]!.key).toBe("checkpoint");
    expect(events[0]!.content).toEqual({ step: 7 });
    expect(events[0]!.scope).toBeUndefined();
  });

  it("pinTool propagates scope when set to 'shared'", async () => {
    const { ctx, events } = makeCtx();
    await pinTool.execute({ key: "checkpoint", content: { cursor: "abc" }, scope: "shared" }, ctx);
    expect(events[0]!.type).toBe("pinned.set");
    expect(events[0]!.scope).toBe("shared");
  });

  it("pinTool accepts named slots beyond 'checkpoint'", async () => {
    const { ctx, events } = makeCtx();
    await pinTool.execute({ key: "persona", content: "you are a helpful agent" }, ctx);
    expect(events[0]!.type).toBe("pinned.set");
    expect(events[0]!.key).toBe("persona");
    expect(events[0]!.content).toBe("you are a helpful agent");
  });

  it("noteTool propagates scope when explicitly set", async () => {
    const { ctx, events } = makeCtx();
    await noteTool.execute({ content: "preference: CSV", scope: "actor" }, ctx);
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
      ["log", "note", "output", "pin", "report"].sort(),
    );
    expect(PLATFORM_TOOLS.note).toBe(noteTool);
    expect(PLATFORM_TOOLS.pin).toBe(pinTool);
    expect(PLATFORM_TOOLS.log).toBe(logTool);
  });
});

describe("pinned.set fold semantics", () => {
  it("reducer folds pinned.set with key='checkpoint' into result.checkpoint with scope captured", () => {
    const events: RunEvent[] = [
      {
        type: "pinned.set",
        timestamp: 1,
        runId: "r",
        key: "checkpoint",
        content: { cursor: "abc" },
        scope: "shared",
      },
    ];
    const result = reduceEvents(events);
    expect(result.checkpoint).toEqual({ cursor: "abc" });
    expect(result.checkpointScope).toBe("shared");
    expect(result.pinned).toEqual({
      checkpoint: { content: { cursor: "abc" }, scope: "shared" },
    });
  });

  it("reducer last-write-wins across multiple pinned.set events with same key", () => {
    const events: RunEvent[] = [
      {
        type: "pinned.set",
        timestamp: 1,
        runId: "r",
        key: "checkpoint",
        content: { v: 1 },
      },
      {
        type: "pinned.set",
        timestamp: 2,
        runId: "r",
        key: "checkpoint",
        content: { v: 2 },
        scope: "actor",
      },
    ];
    const result = reduceEvents(events);
    expect(result.checkpoint).toEqual({ v: 2 });
    expect(result.checkpointScope).toBe("actor");
    expect(result.pinned!.checkpoint).toEqual({ content: { v: 2 }, scope: "actor" });
  });

  it("reducer aggregates named slots beyond 'checkpoint' under result.pinned", () => {
    const events: RunEvent[] = [
      {
        type: "pinned.set",
        timestamp: 1,
        runId: "r",
        key: "persona",
        content: "agent persona",
      },
      {
        type: "pinned.set",
        timestamp: 2,
        runId: "r",
        key: "goals",
        content: ["g1", "g2"],
        scope: "shared",
      },
    ];
    const result = reduceEvents(events);
    expect(result.checkpoint).toBeNull();
    expect(result.pinned).toEqual({
      persona: { content: "agent persona" },
      goals: { content: ["g1", "g2"], scope: "shared" },
    });
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
      { ...base, type: "pinned.set", timestamp: 3, key: "checkpoint", content: { x: 1 } },
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
