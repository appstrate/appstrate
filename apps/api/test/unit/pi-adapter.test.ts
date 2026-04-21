// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  _deriveKeyPlaceholderForTesting as deriveKeyPlaceholder,
  _processPiLogsForTesting as processPiLogs,
} from "../../src/services/adapters/pi.ts";
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

describe("deriveKeyPlaceholder", () => {
  it("returns sk-placeholder for undefined key", () => {
    expect(deriveKeyPlaceholder(undefined)).toBe("sk-placeholder");
  });

  it("returns sk-placeholder for empty string", () => {
    expect(deriveKeyPlaceholder("")).toBe("sk-placeholder");
  });

  it("returns sk-placeholder for key without dashes", () => {
    expect(deriveKeyPlaceholder("simpletokenkey")).toBe("sk-placeholder");
  });

  it("preserves prefix for Anthropic-style keys", () => {
    expect(deriveKeyPlaceholder("sk-ant-api03-secret123")).toBe("sk-ant-api03-placeholder");
  });

  it("preserves prefix for OpenAI-style keys", () => {
    expect(deriveKeyPlaceholder("sk-proj-abc123")).toBe("sk-proj-placeholder");
  });

  it("preserves single-segment prefix", () => {
    expect(deriveKeyPlaceholder("sk-mysecretkey")).toBe("sk-placeholder");
  });

  it("handles multi-segment prefix", () => {
    expect(deriveKeyPlaceholder("a-b-c-d-secret")).toBe("a-b-c-d-placeholder");
  });
});

describe("processPiLogs", () => {
  it("emits appstrate.progress for text_delta lines", async () => {
    const lines = [JSON.stringify({ type: "text_delta", text: "Hello world" })];

    const events = await collectEvents(processPiLogs(linesGenerator(lines), RUN_ID));

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("appstrate.progress");
    expect(events[0]!.message).toBe("Hello world");
  });

  it("passes through output events as output.emitted", async () => {
    const lines = [JSON.stringify({ type: "output", data: { count: 42 } })];

    const events = await collectEvents(processPiLogs(linesGenerator(lines), RUN_ID));

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("output.emitted");
    expect(events[0]!.data).toEqual({ count: 42 });
  });

  it("passes through set_state events as state.set", async () => {
    const lines = [JSON.stringify({ type: "set_state", state: { cursor: "abc" } })];

    const events = await collectEvents(processPiLogs(linesGenerator(lines), RUN_ID));

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("state.set");
    expect(events[0]!.state).toEqual({ cursor: "abc" });
  });

  it("filters out code blocks from text buffer", async () => {
    const lines = [
      JSON.stringify({ type: "text_delta", text: "Before code " }),
      JSON.stringify({ type: "text_delta", text: "```python\nprint('hi')\n```" }),
      JSON.stringify({ type: "text_delta", text: " After code" }),
    ];

    const events = await collectEvents(processPiLogs(linesGenerator(lines), RUN_ID));

    const progressEvents = events.filter((e) => e.type === "appstrate.progress");
    const combined = progressEvents.map((e) => String(e.message ?? "")).join("");
    expect(combined).toContain("Before code");
    expect(combined).not.toContain("print('hi')");
  });

  it("flushes remaining text buffer at end", async () => {
    const lines = [JSON.stringify({ type: "text_delta", text: "Final text" })];

    const events = await collectEvents(processPiLogs(linesGenerator(lines), RUN_ID));

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("appstrate.progress");
    expect(events[0]!.message).toBe("Final text");
  });

  it("handles empty lines gracefully", async () => {
    const lines = ["", "   ", JSON.stringify({ type: "text_delta", text: "valid" })];

    const events = await collectEvents(processPiLogs(linesGenerator(lines), RUN_ID));

    expect(events).toHaveLength(1);
    expect(events[0]!.message).toBe("valid");
  });

  it("flushes text buffer when non-text event arrives", async () => {
    const lines = [
      JSON.stringify({ type: "text_delta", text: "buffered text" }),
      JSON.stringify({ type: "output", data: { result: "done" } }),
    ];

    const events = await collectEvents(processPiLogs(linesGenerator(lines), RUN_ID));

    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("appstrate.progress");
    expect(events[0]!.message).toBe("buffered text");
    expect(events[1]!.type).toBe("output.emitted");
  });

  it("handles tool_start events as appstrate.progress with data", async () => {
    const lines = [
      JSON.stringify({ type: "tool_start", name: "read_file", args: { path: "/tmp/x" } }),
    ];

    const events = await collectEvents(processPiLogs(linesGenerator(lines), RUN_ID));

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("appstrate.progress");
    expect(String(events[0]!.message ?? "")).toContain("read_file");
    expect((events[0]!.data as Record<string, unknown>).tool).toBe("read_file");
  });

  it("handles usage events as appstrate.metric", async () => {
    const lines = [
      JSON.stringify({
        type: "usage",
        tokens: { input: 100, output: 50 },
        cost: 0.005,
      }),
    ];

    const events = await collectEvents(processPiLogs(linesGenerator(lines), RUN_ID));

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("appstrate.metric");
    expect((events[0]!.usage as { input_tokens: number }).input_tokens).toBe(100);
    expect(events[0]!.cost).toBe(0.005);
  });

  it("handles error events as appstrate.error", async () => {
    const lines = [JSON.stringify({ type: "error", message: "Something failed" })];

    const events = await collectEvents(processPiLogs(linesGenerator(lines), RUN_ID));

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("appstrate.error");
    expect(events[0]!.message).toBe("Something failed");
  });

  it("handles non-JSON lines as [container] progress", async () => {
    const lines = ["some raw container output"];

    const events = await collectEvents(processPiLogs(linesGenerator(lines), RUN_ID));

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("appstrate.progress");
    expect(String(events[0]!.message ?? "")).toContain("[container]");
  });

  it("handles add_memory events as memory.added", async () => {
    const lines = [JSON.stringify({ type: "add_memory", content: "Important discovery" })];

    const events = await collectEvents(processPiLogs(linesGenerator(lines), RUN_ID));

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("memory.added");
    expect(events[0]!.content).toBe("Important discovery");
  });

  it("handles log events with levels as appstrate.progress", async () => {
    const lines = [
      JSON.stringify({ type: "log", level: "warn", message: "Rate limit approaching" }),
    ];

    const events = await collectEvents(processPiLogs(linesGenerator(lines), RUN_ID));

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("appstrate.progress");
    expect(events[0]!.level).toBe("warn");
    expect(events[0]!.message).toBe("Rate limit approaching");
  });

  it("auto-flushes when text buffer exceeds 300 chars", async () => {
    const longText = "x".repeat(350);
    const lines = [JSON.stringify({ type: "text_delta", text: longText })];

    const events = await collectEvents(processPiLogs(linesGenerator(lines), RUN_ID));

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.type).toBe("appstrate.progress");
  });
});
