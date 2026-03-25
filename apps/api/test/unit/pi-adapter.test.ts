import { describe, it, expect } from "bun:test";
import {
  _deriveKeyPlaceholderForTesting as deriveKeyPlaceholder,
  _processPiLogsForTesting as processPiLogs,
} from "../../src/services/adapters/pi.ts";
import type { ExecutionMessage } from "../../src/services/adapters/types.ts";

async function collectMessages(gen: AsyncGenerator<ExecutionMessage>): Promise<ExecutionMessage[]> {
  const messages: ExecutionMessage[] = [];
  for await (const msg of gen) {
    messages.push(msg);
  }
  return messages;
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
  it("emits progress for text_delta lines", async () => {
    const lines = [JSON.stringify({ type: "text_delta", text: "Hello world" })];

    const messages = await collectMessages(processPiLogs(linesGenerator(lines)));

    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("progress");
    expect(messages[0]!.message).toBe("Hello world");
  });

  it("passes through output events", async () => {
    const lines = [JSON.stringify({ type: "output", data: { count: 42 } })];

    const messages = await collectMessages(processPiLogs(linesGenerator(lines)));

    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("output");
    expect(messages[0]!.data).toEqual({ count: 42 });
  });

  it("passes through set_state events", async () => {
    const lines = [JSON.stringify({ type: "set_state", state: { cursor: "abc" } })];

    const messages = await collectMessages(processPiLogs(linesGenerator(lines)));

    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("set_state");
    expect(messages[0]!.data).toEqual({ cursor: "abc" });
  });

  it("filters out code blocks from text buffer", async () => {
    const lines = [
      JSON.stringify({ type: "text_delta", text: "Before code " }),
      JSON.stringify({ type: "text_delta", text: "```python\nprint('hi')\n```" }),
      JSON.stringify({ type: "text_delta", text: " After code" }),
    ];

    const messages = await collectMessages(processPiLogs(linesGenerator(lines)));

    // Code blocks should be filtered, "Before code" and "After code" should be emitted
    const progressMessages = messages.filter((m) => m.type === "progress");
    const combined = progressMessages.map((m) => m.message).join("");
    expect(combined).toContain("Before code");
    expect(combined).not.toContain("print('hi')");
  });

  it("flushes remaining text buffer at end", async () => {
    const lines = [JSON.stringify({ type: "text_delta", text: "Final text" })];

    const messages = await collectMessages(processPiLogs(linesGenerator(lines)));

    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("progress");
    expect(messages[0]!.message).toBe("Final text");
  });

  it("handles empty lines gracefully", async () => {
    const lines = ["", "   ", JSON.stringify({ type: "text_delta", text: "valid" })];

    const messages = await collectMessages(processPiLogs(linesGenerator(lines)));

    expect(messages).toHaveLength(1);
    expect(messages[0]!.message).toBe("valid");
  });

  it("flushes text buffer when non-text event arrives", async () => {
    const lines = [
      JSON.stringify({ type: "text_delta", text: "buffered text" }),
      JSON.stringify({ type: "output", data: { result: "done" } }),
    ];

    const messages = await collectMessages(processPiLogs(linesGenerator(lines)));

    // Should have: flushed "buffered text", then output
    expect(messages).toHaveLength(2);
    expect(messages[0]!.type).toBe("progress");
    expect(messages[0]!.message).toBe("buffered text");
    expect(messages[1]!.type).toBe("output");
  });

  it("handles tool_start events as progress with data", async () => {
    const lines = [
      JSON.stringify({ type: "tool_start", name: "read_file", args: { path: "/tmp/x" } }),
    ];

    const messages = await collectMessages(processPiLogs(linesGenerator(lines)));

    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("progress");
    expect(messages[0]!.message).toContain("read_file");
    expect(messages[0]!.data?.tool).toBe("read_file");
  });

  it("handles usage events", async () => {
    const lines = [
      JSON.stringify({
        type: "usage",
        tokens: { input: 100, output: 50 },
        cost: 0.005,
      }),
    ];

    const messages = await collectMessages(processPiLogs(linesGenerator(lines)));

    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("usage");
    expect(messages[0]!.usage?.input_tokens).toBe(100);
    expect(messages[0]!.cost).toBe(0.005);
  });

  it("handles error events", async () => {
    const lines = [JSON.stringify({ type: "error", message: "Something failed" })];

    const messages = await collectMessages(processPiLogs(linesGenerator(lines)));

    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("error");
    expect(messages[0]!.message).toBe("Something failed");
  });

  it("handles non-JSON lines as container output", async () => {
    const lines = ["some raw container output"];

    const messages = await collectMessages(processPiLogs(linesGenerator(lines)));

    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("progress");
    expect(messages[0]!.message).toContain("[container]");
  });

  it("handles add_memory events", async () => {
    const lines = [JSON.stringify({ type: "add_memory", content: "Important discovery" })];

    const messages = await collectMessages(processPiLogs(linesGenerator(lines)));

    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("add_memory");
    expect(messages[0]!.content).toBe("Important discovery");
  });

  it("handles log events with levels", async () => {
    const lines = [
      JSON.stringify({ type: "log", level: "warn", message: "Rate limit approaching" }),
    ];

    const messages = await collectMessages(processPiLogs(linesGenerator(lines)));

    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("progress");
    expect(messages[0]!.level).toBe("warn");
    expect(messages[0]!.message).toBe("Rate limit approaching");
  });

  it("auto-flushes when text buffer exceeds 300 chars", async () => {
    const longText = "x".repeat(350);
    const lines = [JSON.stringify({ type: "text_delta", text: longText })];

    const messages = await collectMessages(processPiLogs(linesGenerator(lines)));

    // Should have been flushed because it exceeded 300 chars
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0]!.type).toBe("progress");
  });
});
