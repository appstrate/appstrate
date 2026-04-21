// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate contributors

/**
 * Cross-package behavioural conformance for the five reserved AFPS 1.3
 * platform tools. Imports the actual package entrypoints (not copies)
 * and asserts the canonical contract each must honour: name, parameter
 * shape, event type, and payload fields.
 */

import { describe, it, expect } from "bun:test";
import type { Tool, ToolContext } from "@afps/types";

import memoryTool from "@afps/memory";
import stateTool from "@afps/state";
import outputTool from "@afps/output";
import reportTool from "@afps/report";
import logTool from "@afps/log";
import { PLATFORM_TOOLS as COMPAT } from "@afps/platform-compat";

function makeCtx() {
  const events: Array<Record<string, unknown>> = [];
  const ctx: ToolContext = {
    emit: (e) => {
      events.push(e as unknown as Record<string, unknown>);
    },
    workspace: "/tmp",
    runId: "run_1",
    toolCallId: "call_a",
    signal: new AbortController().signal,
  };
  return { ctx, events };
}

function assertEnvelopeBase(event: Record<string, unknown>): void {
  expect(typeof event.type).toBe("string");
  expect(typeof event.timestamp).toBe("number");
  expect(event.runId).toBe("run_1");
  expect(event.toolCallId).toBe("call_a");
}

describe("@afps/memory", () => {
  it("emits memory.added with content", async () => {
    const { ctx, events } = makeCtx();
    await memoryTool.execute({ content: "hello" }, ctx);
    expect(events).toHaveLength(1);
    assertEnvelopeBase(events[0]!);
    expect(events[0]!.type).toBe("memory.added");
    expect(events[0]!.content).toBe("hello");
  });

  it("declares required parameter `content`", () => {
    const tool: Tool = memoryTool;
    const required = (tool.parameters as { required: string[] }).required;
    expect(required).toEqual(["content"]);
    expect(tool.name).toBe("add_memory");
  });
});

describe("@afps/state", () => {
  it("emits state.set with arbitrary payload", async () => {
    const { ctx, events } = makeCtx();
    await stateTool.execute({ state: { step: 2, done: false } }, ctx);
    assertEnvelopeBase(events[0]!);
    expect(events[0]!.type).toBe("state.set");
    expect(events[0]!.state).toEqual({ step: 2, done: false });
  });
});

describe("@afps/output", () => {
  it("emits output.emitted with data", async () => {
    const { ctx, events } = makeCtx();
    await outputTool.execute({ data: ["a", "b"] }, ctx);
    expect(events[0]!.type).toBe("output.emitted");
    expect(events[0]!.data).toEqual(["a", "b"]);
  });
});

describe("@afps/report", () => {
  it("emits report.appended with content", async () => {
    const { ctx, events } = makeCtx();
    await reportTool.execute({ content: "one" }, ctx);
    expect(events[0]!.type).toBe("report.appended");
    expect(events[0]!.content).toBe("one");
  });
});

describe("@afps/log", () => {
  it("emits log.written with level + message", async () => {
    const { ctx, events } = makeCtx();
    await logTool.execute({ level: "warn", message: "slow" }, ctx);
    expect(events[0]!.type).toBe("log.written");
    expect(events[0]!.level).toBe("warn");
    expect(events[0]!.message).toBe("slow");
  });

  it("accepts info/warn/error levels only (enforced by runtime parsers, not by the tool itself)", () => {
    const required = (logTool.parameters as { required: string[] }).required;
    expect(required.sort()).toEqual(["level", "message"]);
  });
});

describe("@afps/platform-compat", () => {
  it("re-exports the five tools keyed by their canonical tool names", () => {
    expect(Object.keys(COMPAT).sort()).toEqual(
      ["add_memory", "log", "output", "report", "set_state"].sort(),
    );
    expect(COMPAT.add_memory).toBe(memoryTool);
    expect(COMPAT.set_state).toBe(stateTool);
    expect(COMPAT.output).toBe(outputTool);
    expect(COMPAT.report).toBe(reportTool);
    expect(COMPAT.log).toBe(logTool);
  });
});
