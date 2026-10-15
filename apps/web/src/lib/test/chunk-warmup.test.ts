// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { warmChunk, warmupPending } from "../chunk-warmup";

describe("warmChunk", () => {
  it("holds warmupPending while the chunk is in flight, and releases it once settled", async () => {
    let resolve!: () => void;
    warmChunk(() => new Promise<void>((r) => (resolve = r)));
    expect(warmupPending()).toBe(true);
    resolve();
    await Bun.sleep(0);
    expect(warmupPending()).toBe(false);
  });

  it("swallows a failed download and still releases the count", async () => {
    let reject!: (error: Error) => void;
    warmChunk(() => new Promise<void>((_, r) => (reject = r)));
    // Still held when the rejection lands: that is what `vite:preloadError` reads.
    reject(new Error("stale chunk"));
    expect(warmupPending()).toBe(true);
    await Bun.sleep(0);
    expect(warmupPending()).toBe(false);
  });

  it("counts overlapping warm-ups, so the first to settle does not release the others", async () => {
    let first!: () => void;
    let second!: () => void;
    warmChunk(() => new Promise<void>((r) => (first = r)));
    warmChunk(() => new Promise<void>((r) => (second = r)));
    first();
    await Bun.sleep(0);
    expect(warmupPending()).toBe(true);
    second();
    await Bun.sleep(0);
    expect(warmupPending()).toBe(false);
  });
});
