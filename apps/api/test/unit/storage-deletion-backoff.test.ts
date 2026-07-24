// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the storage-deletion backoff schedule: exponential growth,
 * hard cap at 6h, and jitter bounded to +10%.
 */

import { describe, it, expect } from "bun:test";
import { computeBackoffMs } from "../../src/services/storage-deletion.ts";

const BASE = 30_000;
const CAP = 6 * 60 * 60 * 1000;

describe("computeBackoffMs", () => {
  it("grows exponentially from the 30s base (no jitter)", () => {
    const noJitter = () => 0;
    expect(computeBackoffMs(0, noJitter)).toBe(BASE); // 2^0 * 30s
    expect(computeBackoffMs(1, noJitter)).toBe(BASE * 2);
    expect(computeBackoffMs(2, noJitter)).toBe(BASE * 4);
    expect(computeBackoffMs(3, noJitter)).toBe(BASE * 8);
  });

  it("caps at 6h no matter how many attempts", () => {
    const noJitter = () => 0;
    // 2^10 * 30s = ~8.5h > cap → clamped.
    expect(computeBackoffMs(10, noJitter)).toBe(CAP);
    expect(computeBackoffMs(50, noJitter)).toBe(CAP);
    // Even at the cap, growth is monotonic-then-flat (never decreases).
    expect(computeBackoffMs(20, noJitter)).toBe(CAP);
  });

  it("adds at most 10% jitter on top of the capped interval", () => {
    // rand()=1 → maximum jitter.
    const maxJitter = () => 1;
    expect(computeBackoffMs(0, maxJitter)).toBe(Math.floor(BASE + BASE * 0.1));
    // Capped interval + 10% jitter — never below the base delay, never wildly above.
    const atCap = computeBackoffMs(30, maxJitter);
    expect(atCap).toBeGreaterThanOrEqual(CAP);
    expect(atCap).toBeLessThanOrEqual(Math.floor(CAP * 1.1));
  });

  it("negative attempts clamp to the base (defensive)", () => {
    expect(computeBackoffMs(-5, () => 0)).toBe(BASE);
  });
});
