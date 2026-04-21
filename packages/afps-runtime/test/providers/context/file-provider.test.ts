// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileContextProvider } from "../../../src/providers/context/file-provider.ts";
import type { AfpsEventEnvelope } from "../../../src/types/afps-event.ts";

async function makeTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "afps-file-provider-"));
}

/** Write an envelope-per-line `.jsonl` file to disk. */
async function writeJsonl(path: string, envelopes: AfpsEventEnvelope[]): Promise<void> {
  const body = envelopes.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(path, body, { encoding: "utf8" });
}

function envelope(
  runId: string,
  sequence: number,
  event: AfpsEventEnvelope["event"],
): AfpsEventEnvelope {
  return { runId, sequence, event };
}

describe("FileContextProvider", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("throws when `paths` is empty", () => {
    expect(() => new FileContextProvider({ paths: [] })).toThrow(/at least one file/);
  });

  it("rebuilds memories from add_memory events in a single file", async () => {
    const path = join(dir, "run1.jsonl");
    await writeJsonl(path, [
      envelope("r1", 0, { type: "add_memory", content: "first memory" }),
      envelope("r1", 1, { type: "log", level: "info", message: "noise" }),
      envelope("r1", 2, { type: "add_memory", content: "second memory" }),
    ]);

    const p = new FileContextProvider({ paths: [path] });
    const memories = await p.getMemories();

    expect(memories).toHaveLength(2);
    expect(memories.map((m) => m.content)).toEqual(["first memory", "second memory"]);
    // createdAt comes from file mtime — same for all memories in one file.
    expect(memories[0]!.createdAt).toBe(memories[1]!.createdAt);
  });

  it("applies last-write-wins for set_state", async () => {
    const path = join(dir, "run.jsonl");
    await writeJsonl(path, [
      envelope("r", 0, { type: "set_state", state: { v: 1 } }),
      envelope("r", 1, { type: "set_state", state: { v: 2 } }),
      envelope("r", 2, { type: "set_state", state: { v: 3 } }),
    ]);

    const p = new FileContextProvider({ paths: [path] });
    expect(await p.getState()).toEqual({ v: 3 });
  });

  it("replays multiple files in order: memories accumulate, state wins last", async () => {
    const p1 = join(dir, "run1.jsonl");
    const p2 = join(dir, "run2.jsonl");

    await writeJsonl(p1, [
      envelope("r1", 0, { type: "add_memory", content: "alpha" }),
      envelope("r1", 1, { type: "set_state", state: { run: 1 } }),
    ]);
    await writeJsonl(p2, [
      envelope("r2", 0, { type: "add_memory", content: "beta" }),
      envelope("r2", 1, { type: "set_state", state: { run: 2 } }),
    ]);

    // Force a separate mtime so createdAt is monotonic across files.
    await utimes(p1, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    await utimes(p2, new Date(1_700_000_060_000), new Date(1_700_000_060_000));

    const p = new FileContextProvider({ paths: [p1, p2] });
    const memories = await p.getMemories();

    expect(memories.map((m) => m.content)).toEqual(["alpha", "beta"]);
    expect(memories[0]!.createdAt).toBeLessThan(memories[1]!.createdAt);
    expect(await p.getState()).toEqual({ run: 2 });
  });

  it("dedupes memories by content across files (earliest wins)", async () => {
    const p1 = join(dir, "a.jsonl");
    const p2 = join(dir, "b.jsonl");
    await writeJsonl(p1, [envelope("r1", 0, { type: "add_memory", content: "same" })]);
    await writeJsonl(p2, [envelope("r2", 0, { type: "add_memory", content: "same" })]);

    const p = new FileContextProvider({ paths: [p1, p2] });
    const memories = await p.getMemories();
    expect(memories).toHaveLength(1);
  });

  it("honors limit + since on getMemories", async () => {
    const p1 = join(dir, "old.jsonl");
    const p2 = join(dir, "new.jsonl");
    await writeJsonl(p1, [envelope("r1", 0, { type: "add_memory", content: "old" })]);
    await writeJsonl(p2, [envelope("r2", 0, { type: "add_memory", content: "new" })]);

    await utimes(p1, new Date(1000), new Date(1000));
    await utimes(p2, new Date(2000), new Date(2000));

    const provider = new FileContextProvider({ paths: [p1, p2] });
    expect(await provider.getMemories({ limit: 1 })).toHaveLength(1);
    expect(await provider.getMemories({ since: 1500 })).toEqual([
      expect.objectContaining({ content: "new" }),
    ]);
  });

  it("skips malformed / non-JSON / unknown-type lines silently", async () => {
    const path = join(dir, "noisy.jsonl");
    const body = [
      JSON.stringify(envelope("r", 0, { type: "add_memory", content: "ok" })),
      "{not-json",
      "",
      "   ",
      '{"runId":"r","sequence":1,"event":{"type":"unknown_kind"}}',
      '"just a string"',
      JSON.stringify(envelope("r", 2, { type: "add_memory", content: "also ok" })),
    ].join("\n");
    await writeFile(path, body, { encoding: "utf8" });

    const p = new FileContextProvider({ paths: [path] });
    const memories = await p.getMemories();
    expect(memories.map((m) => m.content)).toEqual(["ok", "also ok"]);
  });

  it("returns empty history (intentional — use SnapshotContextProvider for history)", async () => {
    const path = join(dir, "run.jsonl");
    await writeJsonl(path, [envelope("r", 0, { type: "add_memory", content: "m" })]);
    const p = new FileContextProvider({ paths: [path] });
    expect(await p.getHistory()).toEqual([]);
  });

  it("returns undefined for getResource (not supported in file mode)", async () => {
    const path = join(dir, "run.jsonl");
    await writeJsonl(path, []);
    await writeFile(path, "", { encoding: "utf8" });
    const p = new FileContextProvider({ paths: [path] });
    expect(await p.getResource!("anything")).toBeUndefined();
  });

  it("caches the load across calls (idempotent)", async () => {
    const path = join(dir, "run.jsonl");
    await writeJsonl(path, [envelope("r", 0, { type: "add_memory", content: "once" })]);

    const p = new FileContextProvider({ paths: [path] });
    const a = await p.getMemories();
    const b = await p.getMemories();
    // Same array reference is NOT guaranteed (we slice), but the shape must be identical.
    expect(a).toEqual(b);
  });
});
