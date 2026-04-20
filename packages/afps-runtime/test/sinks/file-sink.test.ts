// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSink } from "../../src/sinks/file-sink.ts";
import type { AfpsEventEnvelope } from "../../src/types/afps-event.ts";

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

    const envelopes: AfpsEventEnvelope[] = [
      { runId: "r", sequence: 1, event: { type: "add_memory", content: "a" } },
      { runId: "r", sequence: 2, event: { type: "log", level: "info", message: "x" } },
    ];

    for (const e of envelopes) await sink.onEvent(e);

    const text = await readFile(path, "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(envelopes[0]!);
    expect(JSON.parse(lines[1]!)).toEqual(envelopes[1]!);
  });

  it("writes the aggregated result to a companion .result.json", async () => {
    const path = join(dir, "run.jsonl");
    const sink = new FileSink({ path });

    await sink.finalize({
      memories: [{ content: "hi" }],
      state: { n: 1 },
      output: null,
      report: null,
      logs: [],
    });

    const text = await readFile(`${path}.result.json`, "utf8");
    const parsed = JSON.parse(text);
    expect(parsed.memories).toEqual([{ content: "hi" }]);
    expect(parsed.state).toEqual({ n: 1 });
  });

  it("creates parent directories when missing", async () => {
    const path = join(dir, "deeply", "nested", "run.jsonl");
    const sink = new FileSink({ path });

    await sink.onEvent({
      runId: "r",
      sequence: 1,
      event: { type: "add_memory", content: "x" },
    });

    const text = await readFile(path, "utf8");
    expect(text).toContain("add_memory");
  });

  it("preserves event ordering across many onEvent calls", async () => {
    const path = join(dir, "order.jsonl");
    const sink = new FileSink({ path });

    for (let i = 0; i < 50; i++) {
      await sink.onEvent({
        runId: "r",
        sequence: i,
        event: { type: "add_memory", content: `m${i}` },
      });
    }

    const text = await readFile(path, "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(50);
    for (let i = 0; i < 50; i++) {
      expect(JSON.parse(lines[i]!).sequence).toBe(i);
    }
  });
});
