// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSink } from "../../src/sinks/file-sink.ts";
import type { RunEvent } from "@afps-spec/types";

function event(type: string, extra: Record<string, unknown> = {}): RunEvent {
  return { type, timestamp: 0, runId: "r", ...extra };
}

describe("FileSink", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "afps-file-sink-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("appends each event as a JSON line", async () => {
    const path = join(dir, "run.jsonl");
    const sink = new FileSink({ path });

    const events: RunEvent[] = [
      event("memory.added", { content: "a" }),
      event("log.written", { level: "info", message: "x" }),
    ];

    for (const e of events) await sink.handle(e);

    const text = await readFile(path, "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(events[0]!);
    expect(JSON.parse(lines[1]!)).toEqual(events[1]!);
  });

  it("writes the aggregated result to a companion .result.json", async () => {
    const path = join(dir, "run.jsonl");
    const sink = new FileSink({ path });

    await sink.finalize({
      memories: [{ content: "hi" }],
      pinned: { checkpoint: { content: { n: 1 } } },
      output: null,
      logs: [],
    });

    const text = await readFile(`${path}.result.json`, "utf8");
    const parsed = JSON.parse(text);
    expect(parsed.memories).toEqual([{ content: "hi" }]);
    expect(parsed.pinned).toEqual({ checkpoint: { content: { n: 1 } } });
  });

  it("creates parent directories when missing", async () => {
    const path = join(dir, "deeply", "nested", "run.jsonl");
    const sink = new FileSink({ path });

    await sink.handle(event("memory.added", { content: "x" }));

    const text = await readFile(path, "utf8");
    expect(text).toContain("memory.added");
  });

  it("preserves event ordering across many handle calls", async () => {
    const path = join(dir, "order.jsonl");
    const sink = new FileSink({ path });

    for (let i = 0; i < 50; i++) {
      await sink.handle(event("memory.added", { content: `m${i}`, index: i }));
    }

    const text = await readFile(path, "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(50);
    for (let i = 0; i < 50; i++) {
      expect(JSON.parse(lines[i]!).index).toBe(i);
    }
  });
});
