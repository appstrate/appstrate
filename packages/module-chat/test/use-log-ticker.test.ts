// SPDX-License-Identifier: Apache-2.0

/** `tickerIndex`: which log entry a run's line shows, before the next is paced in. */

import { describe, expect, it } from "bun:test";
import { tickerIndex } from "../src/ui/use-log-ticker.ts";

describe("tickerIndex", () => {
  it("shows nothing while the queue is empty", () => {
    expect(tickerIndex(-1, -1)).toBe(-1);
    expect(tickerIndex(3, -1)).toBe(-1);
  });

  it("lands the first batch on its last entry, not a replay of the run's history", () => {
    expect(tickerIndex(-1, 0)).toBe(0);
    expect(tickerIndex(-1, 41)).toBe(41);
  });

  it("keeps the entry shown once entries arrive after it: they are paced in", () => {
    expect(tickerIndex(41, 44)).toBe(41);
  });

  it("clamps an entry past a queue that shrank", () => {
    expect(tickerIndex(5, 2)).toBe(2);
  });
});
