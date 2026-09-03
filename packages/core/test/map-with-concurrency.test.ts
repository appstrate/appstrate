// SPDX-License-Identifier: Apache-2.0

/**
 * Order preservation, the concurrency cap, and abort-on-first-rejection — the
 * property callers that roll back partial work rely on.
 */

import { describe, it, expect } from "bun:test";
import { mapWithConcurrency } from "../src/map-with-concurrency.ts";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("mapWithConcurrency", () => {
  it("preserves input order in the result", async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      await tick();
      return n * n;
    });
    expect(out).toEqual([1, 4, 9, 16, 25]);
  });

  it("never runs more than `limit` callbacks at once", async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async () => {
        active++;
        peak = Math.max(peak, active);
        await tick();
        active--;
        return null;
      },
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // actually parallelised, not serialised
  });

  it("uses at most `items.length` workers when limit exceeds the item count", async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2], 16, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await tick();
      active--;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("rejects on the first error and starts no further items", async () => {
    let started = 0;
    let thrown: unknown;
    try {
      await mapWithConcurrency(
        Array.from({ length: 10 }, (_, i) => i),
        2,
        async (i) => {
          started++;
          await tick();
          if (i === 0) throw new Error("boom");
          return i;
        },
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("boom");
    // With a cap of 2 and the failure on the first item, the in-flight pair may
    // both start, but the loop stops pulling new work — nowhere near all 10.
    expect(started).toBeLessThan(10);
  });

  // The property the deleted `mapBounded` lacked, pinned deterministically: a
  // gate holds every surviving worker until after the rejection has surfaced,
  // so "what started" is not a function of timer-callback ordering. The old
  // pool started all 10 here; this one starts only the 4 that were in flight.
  it("starts NO further item once a callback has rejected", async () => {
    const started: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const pending = mapWithConcurrency(
      Array.from({ length: 10 }, (_, i) => i),
      4,
      async (i) => {
        started.push(i);
        if (i === 2) throw new Error("boom");
        await gate;
        return i;
      },
    );

    await expect(pending).rejects.toThrow("boom");
    // Let the three still-blocked workers resume: they must break out of the
    // loop instead of pulling items 4-9.
    release();
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);
  });
});
