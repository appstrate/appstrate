// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect, beforeEach } from "bun:test";
import { ConsoleSink, type ConsoleWritable } from "../../src/sinks/console-sink.ts";
import type { RunEvent } from "@afps-spec/types";

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

function event(type: string, extra: Record<string, unknown> = {}): RunEvent {
  return { type, timestamp: 0, runId: "r", ...extra };
}

describe("ConsoleSink", () => {
  let buf: BufferWritable;
  let sink: ConsoleSink;

  beforeEach(() => {
    buf = new BufferWritable();
    sink = new ConsoleSink({ out: buf });
  });

  it("formats memory.added with a sequence prefix", async () => {
    await sink.handle(event("memory.added", { content: "pref metric" }));
    expect(buf.output).toContain("#0001");
    expect(buf.output).toContain("pref metric");
    expect(buf.output.endsWith("\n")).toBe(true);
  });

  it("increments the sequence prefix monotonically across calls", async () => {
    await sink.handle(event("memory.added", { content: "a" }));
    await sink.handle(event("memory.added", { content: "b" }));
    const lines = buf.output.trim().split("\n");
    expect(lines[0]).toContain("#0001");
    expect(lines[1]).toContain("#0002");
  });

  it("formats each canonical event kind distinctly", async () => {
    await sink.handle(event("pinned.set", { key: "checkpoint", content: { a: 1 } }));
    await sink.handle(event("output.emitted", { data: "x" }));
    await sink.handle(event("log.written", { level: "warn", message: "careful" }));
    const lines = buf.output.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("pinned[checkpoint]");
    expect(lines[1]).toContain("output");
    expect(lines[2]).toContain("careful");
  });

  it("formats unknown / third-party event types with a fallback marker", async () => {
    await sink.handle(event("@my-org/audit.logged", { actor: "u_1", action: "delete" }));
    expect(buf.output).toContain("@my-org/audit.logged");
    expect(buf.output).toContain("u_1");
  });

  it("truncates very long payloads", async () => {
    const long = "a".repeat(1000);
    await sink.handle(event("memory.added", { content: long }));
    expect(buf.output.length).toBeLessThan(300);
    expect(buf.output).toContain("…");
  });

  it("writes a summary on finalize", async () => {
    await sink.finalize({
      memories: [{ content: "a" }, { content: "b" }],
      pinned: { checkpoint: { content: { foo: 1 } } },
      output: { done: true },
      logs: [{ level: "info", message: "ok", timestamp: 0 }],
    });
    expect(buf.output).toContain("memories=2");
    expect(buf.output).toContain("logs=1");
    expect(buf.output).toContain("output=set");
    expect(buf.output).toContain("checkpoint=set");
  });

  it("surfaces errors in the summary", async () => {
    await sink.finalize({
      memories: [],
      output: null,
      logs: [],
      error: { message: "boom" },
    });
    expect(buf.output).toContain("ERROR=boom");
  });
});
