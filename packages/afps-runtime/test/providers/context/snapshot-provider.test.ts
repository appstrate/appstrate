// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { SnapshotContextProvider } from "../../../src/providers/context/snapshot-provider.ts";
import type { HistoryEntry, MemorySnapshot } from "../../../src/types/execution-context.ts";

const MEMORIES: MemorySnapshot[] = [
  { content: "m1", createdAt: 1000 },
  { content: "m2", createdAt: 2000 },
  { content: "m3", createdAt: 3000 },
];

const HISTORY: HistoryEntry[] = [
  { runId: "r1", timestamp: 1000, output: "a" },
  { runId: "r2", timestamp: 2000, output: "b" },
];

describe("SnapshotContextProvider", () => {
  it("returns the snapshot values unchanged", async () => {
    const p = new SnapshotContextProvider({
      memories: MEMORIES,
      history: HISTORY,
      state: { counter: 42 },
      resources: {
        "doc://readme": { content: "hello", mimeType: "text/plain" },
      },
    });

    expect(await p.getMemories()).toEqual(MEMORIES);
    expect(await p.getHistory()).toEqual(HISTORY);
    expect(await p.getState()).toEqual({ counter: 42 });
    expect(await p.getResource!("doc://readme")).toEqual({
      content: "hello",
      mimeType: "text/plain",
    });
  });

  it("defaults to empty collections and null state", async () => {
    const p = new SnapshotContextProvider();
    expect(await p.getMemories()).toEqual([]);
    expect(await p.getHistory()).toEqual([]);
    expect(await p.getState()).toBeNull();
    expect(await p.getResource!("doc://missing")).toBeUndefined();
  });

  it("honors `limit` on memories", async () => {
    const p = new SnapshotContextProvider({ memories: MEMORIES });
    expect(await p.getMemories({ limit: 2 })).toEqual(MEMORIES.slice(0, 2));
  });

  it("honors `since` on memories (filters older)", async () => {
    const p = new SnapshotContextProvider({ memories: MEMORIES });
    const result = await p.getMemories({ since: 2000 });
    expect(result).toEqual([
      { content: "m2", createdAt: 2000 },
      { content: "m3", createdAt: 3000 },
    ]);
  });

  it("honors `limit` on history", async () => {
    const p = new SnapshotContextProvider({ history: HISTORY });
    expect(await p.getHistory({ limit: 1 })).toEqual([HISTORY[0]!]);
  });

  it("combines `limit` + `since` on memories", async () => {
    const p = new SnapshotContextProvider({ memories: MEMORIES });
    expect(await p.getMemories({ since: 1000, limit: 2 })).toEqual(MEMORIES.slice(0, 2));
  });

  it("treats a null state as null (not 'no state set')", async () => {
    const p = new SnapshotContextProvider({ state: null });
    expect(await p.getState()).toBeNull();
  });

  it("propagates an object state verbatim", async () => {
    const state = { nested: { a: [1, 2, 3] } };
    const p = new SnapshotContextProvider({ state });
    expect(await p.getState()).toEqual(state);
  });
});
