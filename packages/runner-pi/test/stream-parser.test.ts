// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * runtime-pi/entrypoint.ts drives a {@link PiRunner} that emits canonical
 * AFPS {@link RunEvent}s on stdout. The parser + log processor are a thin
 * shape validator + text-delta buffer on top of that.
 */

import { describe, it, expect } from "bun:test";
import { parsePiStreamLine, processPiLogs } from "../src/stream-parser.ts";
import type { RunEvent } from "@appstrate/afps-runtime/types";

const RUN_ID = "run_test";

async function collectEvents(gen: AsyncGenerator<RunEvent>): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const ev of gen) {
    events.push(ev);
  }
  return events;
}

async function* linesGenerator(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) {
    yield line;
  }
}

function runEvent(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, timestamp: 0, runId: RUN_ID, ...extra });
}

describe("parsePiStreamLine", () => {
  it("passes through a well-formed RunEvent verbatim", () => {
    const event = {
      type: "memory.added",
      timestamp: 1_700_000_000,
      runId: RUN_ID,
      content: "learned X",
    };
    const parsed = parsePiStreamLine(JSON.stringify(event), RUN_ID)!;
    expect(parsed.type).toBe("memory.added");
    expect(parsed.content).toBe("learned X");
    expect(parsed.runId).toBe(RUN_ID);
    expect(parsed.timestamp).toBe(1_700_000_000);
  });

  it("passes through an appstrate.metric event unchanged", () => {
    const event = {
      type: "appstrate.metric",
      timestamp: 1_700_000_000,
      runId: RUN_ID,
      usage: { input_tokens: 100, output_tokens: 50 },
      cost: 0.004,
    };
    const parsed = parsePiStreamLine(JSON.stringify(event), RUN_ID)!;
    expect(parsed.type).toBe("appstrate.metric");
    expect(parsed.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
    expect(parsed.cost).toBe(0.004);
  });

  it("wraps non-RunEvent JSON as a [container] progress breadcrumb", () => {
    const line = JSON.stringify({ random: "object", not: "a run event" });
    const parsed = parsePiStreamLine(line, RUN_ID)!;
    expect(parsed.type).toBe("appstrate.progress");
    expect(String(parsed.message ?? "")).toContain("[container]");
  });

  it("wraps unparseable lines as a [container] progress breadcrumb", () => {
    const parsed = parsePiStreamLine("this is not JSON", RUN_ID)!;
    expect(parsed.type).toBe("appstrate.progress");
    expect(String(parsed.message ?? "")).toContain("this is not JSON");
  });

  it("returns null on empty / whitespace-only lines", () => {
    expect(parsePiStreamLine("", RUN_ID)).toBeNull();
    expect(parsePiStreamLine("   \n", RUN_ID)).toBeNull();
  });

  it("rejects events missing required envelope fields", () => {
    const missingRunId = JSON.stringify({ type: "output.emitted", timestamp: 1 });
    const parsed = parsePiStreamLine(missingRunId, RUN_ID)!;
    expect(parsed.type).toBe("appstrate.progress");
    expect(String(parsed.message ?? "")).toContain("[container]");
  });
});

describe("processPiLogs", () => {
  it("buffers appstrate.progress text_delta-style messages", async () => {
    const lines = [runEvent("appstrate.progress", { message: "Hello world" })];
    const events = await collectEvents(processPiLogs(linesGenerator(lines), RUN_ID));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("appstrate.progress");
    expect(events[0]!.message).toBe("Hello world");
  });

  it("passes through output.emitted events verbatim", async () => {
    const lines = [runEvent("output.emitted", { data: { count: 42 } })];
    const events = await collectEvents(processPiLogs(linesGenerator(lines), RUN_ID));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("output.emitted");
    expect(events[0]!.data).toEqual({ count: 42 });
  });

  it("passes through state.set events verbatim", async () => {
    const lines = [runEvent("state.set", { state: { cursor: "abc" } })];
    const events = await collectEvents(processPiLogs(linesGenerator(lines), RUN_ID));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("state.set");
    expect(events[0]!.state).toEqual({ cursor: "abc" });
  });

  it("filters out code blocks from buffered progress text", async () => {
    const lines = [
      runEvent("appstrate.progress", { message: "Before code " }),
      runEvent("appstrate.progress", { message: "```python\nprint('hi')\n```" }),
      runEvent("appstrate.progress", { message: " After code" }),
    ];
    const events = await collectEvents(processPiLogs(linesGenerator(lines), RUN_ID));
    const progressEvents = events.filter((e) => e.type === "appstrate.progress");
    const combined = progressEvents.map((e) => String(e.message ?? "")).join("");
    expect(combined).toContain("Before code");
    expect(combined).not.toContain("print('hi')");
  });

  it("flushes remaining text buffer at end of stream", async () => {
    const lines = [runEvent("appstrate.progress", { message: "Final text" })];
    const events = await collectEvents(processPiLogs(linesGenerator(lines), RUN_ID));
    expect(events).toHaveLength(1);
    expect(events[0]!.message).toBe("Final text");
  });

  it("handles empty / whitespace lines gracefully", async () => {
    const lines = ["", "   ", runEvent("appstrate.progress", { message: "valid" })];
    const events = await collectEvents(processPiLogs(linesGenerator(lines), RUN_ID));
    expect(events).toHaveLength(1);
    expect(events[0]!.message).toBe("valid");
  });

  it("flushes text buffer when a non-progress event arrives", async () => {
    const lines = [
      runEvent("appstrate.progress", { message: "buffered text" }),
      runEvent("output.emitted", { data: { result: "done" } }),
    ];
    const events = await collectEvents(processPiLogs(linesGenerator(lines), RUN_ID));
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("appstrate.progress");
    expect(events[0]!.message).toBe("buffered text");
    expect(events[1]!.type).toBe("output.emitted");
  });

  it("passes through progress events that carry structured data unchanged", async () => {
    const lines = [
      runEvent("appstrate.progress", {
        message: "Tool: read_file",
        data: { tool: "read_file", args: { path: "/tmp/x" } },
      }),
    ];
    const events = await collectEvents(processPiLogs(linesGenerator(lines), RUN_ID));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("appstrate.progress");
    expect((events[0]!.data as Record<string, unknown>).tool).toBe("read_file");
  });

  it("passes through appstrate.metric events verbatim", async () => {
    const lines = [
      runEvent("appstrate.metric", {
        usage: { input_tokens: 100, output_tokens: 50 },
        cost: 0.005,
      }),
    ];
    const events = await collectEvents(processPiLogs(linesGenerator(lines), RUN_ID));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("appstrate.metric");
    expect((events[0]!.usage as { input_tokens: number }).input_tokens).toBe(100);
    expect(events[0]!.cost).toBe(0.005);
  });

  it("passes through appstrate.error events verbatim", async () => {
    const lines = [runEvent("appstrate.error", { message: "Something failed" })];
    const events = await collectEvents(processPiLogs(linesGenerator(lines), RUN_ID));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("appstrate.error");
    expect(events[0]!.message).toBe("Something failed");
  });

  it("wraps non-JSON lines as [container] breadcrumbs", async () => {
    const lines = ["some raw container output"];
    const events = await collectEvents(processPiLogs(linesGenerator(lines), RUN_ID));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("appstrate.progress");
    expect(String(events[0]!.message ?? "")).toContain("[container]");
  });

  it("passes through memory.added events verbatim", async () => {
    const lines = [runEvent("memory.added", { content: "Important discovery" })];
    const events = await collectEvents(processPiLogs(linesGenerator(lines), RUN_ID));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("memory.added");
    expect(events[0]!.content).toBe("Important discovery");
  });

  it("passes through progress events with a level unchanged", async () => {
    const lines = [
      runEvent("appstrate.progress", { message: "Rate limit approaching", level: "warn" }),
    ];
    const events = await collectEvents(processPiLogs(linesGenerator(lines), RUN_ID));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("appstrate.progress");
    expect(events[0]!.level).toBe("warn");
    expect(events[0]!.message).toBe("Rate limit approaching");
  });

  it("auto-flushes when the buffered text exceeds 300 chars", async () => {
    const longText = "x".repeat(350);
    const lines = [runEvent("appstrate.progress", { message: longText })];
    const events = await collectEvents(processPiLogs(linesGenerator(lines), RUN_ID));
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.type).toBe("appstrate.progress");
  });
});
