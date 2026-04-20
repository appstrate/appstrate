// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect, beforeEach } from "bun:test";
import { ConsoleSink, type ConsoleWritable } from "../../src/sinks/console-sink.ts";

class BufferWritable implements ConsoleWritable {
  readonly chunks: string[] = [];
  write(chunk: string): unknown {
    this.chunks.push(chunk);
    return true;
  }
  get output(): string {
    return this.chunks.join("");
  }
}

describe("ConsoleSink", () => {
  let buf: BufferWritable;
  let sink: ConsoleSink;

  beforeEach(() => {
    buf = new BufferWritable();
    sink = new ConsoleSink({ out: buf });
  });

  it("formats add_memory with the sequence prefix", async () => {
    await sink.onEvent({
      runId: "r",
      sequence: 1,
      event: { type: "add_memory", content: "pref metric" },
    });
    expect(buf.output).toContain("#0001");
    expect(buf.output).toContain("pref metric");
    expect(buf.output.endsWith("\n")).toBe(true);
  });

  it("formats each event kind distinctly", async () => {
    await sink.onEvent({ runId: "r", sequence: 2, event: { type: "set_state", state: { a: 1 } } });
    await sink.onEvent({ runId: "r", sequence: 3, event: { type: "output", data: "x" } });
    await sink.onEvent({ runId: "r", sequence: 4, event: { type: "report", content: "# R" } });
    await sink.onEvent({
      runId: "r",
      sequence: 5,
      event: { type: "log", level: "warn", message: "careful" },
    });
    const lines = buf.output.trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("state");
    expect(lines[1]).toContain("output");
    expect(lines[2]).toContain("report");
    expect(lines[3]).toContain("careful");
  });

  it("truncates very long payloads", async () => {
    const long = "a".repeat(1000);
    await sink.onEvent({ runId: "r", sequence: 1, event: { type: "add_memory", content: long } });
    // 200 max + "#0001 ✚ memory: " prefix + newline
    expect(buf.output.length).toBeLessThan(300);
    expect(buf.output).toContain("…");
  });

  it("writes a summary on finalize", async () => {
    await sink.finalize({
      memories: [{ content: "a" }, { content: "b" }],
      state: { foo: 1 },
      output: { done: true },
      report: "# Done",
      logs: [{ level: "info", message: "ok", timestamp: 0 }],
    });
    expect(buf.output).toContain("memories=2");
    expect(buf.output).toContain("logs=1");
    expect(buf.output).toContain("output=set");
    expect(buf.output).toContain("report=set");
    expect(buf.output).toContain("state=set");
  });

  it("surfaces errors in the summary", async () => {
    await sink.finalize({
      memories: [],
      state: null,
      output: null,
      report: null,
      logs: [],
      error: { message: "boom" },
    });
    expect(buf.output).toContain("ERROR=boom");
  });
});
