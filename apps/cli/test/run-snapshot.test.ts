// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `appstrate run --snapshot <path>`.
 *
 * Covers the JSON contract, the three seedable keys, validation
 * errors, and the `ExecutionContext` merge semantics. No PiRunner or
 * LLM in sight — the behaviour under test is a pure data transform.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionContext } from "@appstrate/afps-runtime/types";
import {
  loadSnapshotFile,
  mergeSnapshotIntoContext,
  SnapshotError,
} from "../src/commands/run/snapshot.ts";

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "appstrate-snapshot-test-"));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeSnapshot(name: string, body: unknown): string {
  const path = join(tmp, name);
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
}

describe("loadSnapshotFile", () => {
  it("reads the three seedable keys from a well-formed file", async () => {
    const path = writeSnapshot("ok.json", {
      memories: [{ content: "hello", createdAt: 1 }],
      history: [{ runId: "prev-1", timestamp: 1713369600, output: { summary: "hi" } }],
      checkpoint: "2026-04-23",
    });
    const snap = await loadSnapshotFile(path);
    expect(snap.memories).toEqual([{ content: "hello", createdAt: 1 }]);
    expect(snap.history).toEqual([
      { runId: "prev-1", timestamp: 1713369600, output: { summary: "hi" } },
    ]);
    expect(snap.checkpoint).toBe("2026-04-23");
  });

  it("drops unknown keys instead of passing them through", async () => {
    const path = writeSnapshot("extra.json", {
      memories: [],
      runId: "should-be-ignored",
      bogus: { nope: true },
    });
    const snap = await loadSnapshotFile(path);
    expect(snap).toEqual({ memories: [] });
  });

  it("returns an empty object when all seedable keys are absent", async () => {
    const path = writeSnapshot("empty.json", {});
    const snap = await loadSnapshotFile(path);
    expect(snap).toEqual({});
  });

  it("throws SnapshotError when the file is missing", async () => {
    await expect(loadSnapshotFile(join(tmp, "nope.json"))).rejects.toBeInstanceOf(SnapshotError);
  });

  it("throws SnapshotError on invalid JSON", async () => {
    const path = writeSnapshot("broken.json", "{not-json");
    await expect(loadSnapshotFile(path)).rejects.toBeInstanceOf(SnapshotError);
  });

  it("rejects a non-object top-level JSON value", async () => {
    const path = writeSnapshot("array.json", ["nope"]);
    await expect(loadSnapshotFile(path)).rejects.toBeInstanceOf(SnapshotError);
  });

  it("rejects a non-array memories field", async () => {
    const path = writeSnapshot("bad-memories.json", { memories: "string instead of array" });
    await expect(loadSnapshotFile(path)).rejects.toMatchObject({
      name: "SnapshotError",
      message: expect.stringContaining("memories"),
    });
  });

  it("rejects a non-array history field", async () => {
    const path = writeSnapshot("bad-history.json", { history: { oops: true } });
    await expect(loadSnapshotFile(path)).rejects.toMatchObject({
      name: "SnapshotError",
      message: expect.stringContaining("history"),
    });
  });

  it("treats an explicit undefined checkpoint as absent", async () => {
    const path = writeSnapshot("undef-checkpoint.json", { memories: [] });
    const snap = await loadSnapshotFile(path);
    expect("checkpoint" in snap).toBe(false);
  });

  it("preserves a null checkpoint (user opted in)", async () => {
    const path = writeSnapshot("null-checkpoint.json", { checkpoint: null });
    const snap = await loadSnapshotFile(path);
    expect(snap.checkpoint).toBeNull();
  });
});

describe("mergeSnapshotIntoContext", () => {
  const baseContext: ExecutionContext = {
    runId: "run-abc",
    input: { topic: "weekly" },
    memories: [],
    config: { mode: "daily" },
  };

  it("is a no-op when the snapshot is empty", () => {
    const out = mergeSnapshotIntoContext(baseContext, {});
    expect(out).toEqual(baseContext);
  });

  it("replaces memories wholesale (never concatenates)", () => {
    const existingMemoryCtx: ExecutionContext = {
      ...baseContext,
      memories: [{ content: "old", createdAt: 0 }],
    };
    const out = mergeSnapshotIntoContext(existingMemoryCtx, {
      memories: [{ content: "new", createdAt: 10 }],
    });
    expect(out.memories).toEqual([{ content: "new", createdAt: 10 }]);
  });

  it("seeds history when the base context has none", () => {
    const entry = { runId: "prev-1", timestamp: 1713369600, output: { summary: "prior" } };
    const out = mergeSnapshotIntoContext(baseContext, { history: [entry] });
    expect(out.history).toEqual([entry]);
  });

  it("seeds checkpoint and preserves unrelated context fields", () => {
    const out = mergeSnapshotIntoContext(baseContext, { checkpoint: "2026-04-13" });
    expect(out.checkpoint).toBe("2026-04-13");
    expect(out.runId).toBe(baseContext.runId);
    expect(out.input).toEqual(baseContext.input);
    expect(out.config).toEqual(baseContext.config);
  });

  it("lets a present snapshot key override an existing context value", () => {
    const ctxWithCheckpoint = { ...baseContext, checkpoint: "before" } as ExecutionContext;
    const out = mergeSnapshotIntoContext(ctxWithCheckpoint, { checkpoint: "after" });
    expect(out.checkpoint).toBe("after");
  });

  it("leaves existing context values untouched when the snapshot omits them", () => {
    const ctxWithAll: ExecutionContext = {
      ...baseContext,
      memories: [{ content: "keep", createdAt: 1 }],
      history: [{ runId: "prev-keep", timestamp: 1, output: { summary: "keep" } }],
      checkpoint: "keep",
    };
    const out = mergeSnapshotIntoContext(ctxWithAll, {});
    expect(out.memories).toEqual([{ content: "keep", createdAt: 1 }]);
    expect(out.history).toEqual([
      { runId: "prev-keep", timestamp: 1, output: { summary: "keep" } },
    ]);
    expect(out.checkpoint).toBe("keep");
  });
});
