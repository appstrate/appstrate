// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  deriveResponseReserveTokens,
  isUsableMaxOutputTokens,
  RESERVE_FLOOR_TOKENS,
} from "@appstrate/core/token-budget";

describe("isUsableMaxOutputTokens", () => {
  it("accepts a positive cap strictly below the window", () => {
    expect(isUsableMaxOutputTokens(64_000, 200_000)).toBe(true);
    expect(isUsableMaxOutputTokens(1, 2)).toBe(true);
  });

  it("rejects a cap that equals or exceeds the window (canonical invariant)", () => {
    expect(isUsableMaxOutputTokens(256_000, 256_000)).toBe(false);
    expect(isUsableMaxOutputTokens(300_000, 256_000)).toBe(false);
  });

  it("rejects null, undefined, non-finite, and non-positive caps", () => {
    expect(isUsableMaxOutputTokens(null, 200_000)).toBe(false);
    expect(isUsableMaxOutputTokens(undefined, 200_000)).toBe(false);
    expect(isUsableMaxOutputTokens(0, 200_000)).toBe(false);
    expect(isUsableMaxOutputTokens(-1, 200_000)).toBe(false);
    expect(isUsableMaxOutputTokens(NaN, 200_000)).toBe(false);
    expect(isUsableMaxOutputTokens(Infinity, 200_000)).toBe(false);
  });
});

describe("deriveResponseReserveTokens", () => {
  it("honours a usable explicit maxTokens below the ceiling", () => {
    // Claude Sonnet thinking @ 64k on a 200k window must stay 64k.
    expect(deriveResponseReserveTokens(200_000, 64_000)).toBe(64_000);
  });

  it("derives max(floor, 20% × window) when maxTokens is missing", () => {
    expect(deriveResponseReserveTokens(200_000, null)).toBe(40_000);
    expect(deriveResponseReserveTokens(200_000, undefined)).toBe(40_000);
    // Floor wins on small windows: 50_000 × 0.2 = 10_000 < 16_384.
    expect(deriveResponseReserveTokens(50_000, null)).toBe(RESERVE_FLOOR_TOKENS);
  });

  it("clamps an impossible maxTokens == contextWindow to the derived default", () => {
    // Devstral 2512 regression: 256k window, bogus 256k max output.
    expect(deriveResponseReserveTokens(256_000, 256_000)).toBe(51_200);
  });

  it("clamps maxTokens > contextWindow to the derived default", () => {
    expect(deriveResponseReserveTokens(128_000, 200_000)).toBe(
      Math.max(RESERVE_FLOOR_TOKENS, Math.floor(128_000 * 0.2)),
    );
  });

  it("never returns a reserve >= contextWindow, even for tiny windows", () => {
    for (const ctx of [500, 1_000, 8_000, 32_000, 128_000, 256_000, 1_000_000]) {
      for (const max of [null, ctx, ctx + 1, ctx * 2, Math.floor(ctx / 2)]) {
        const reserve = deriveResponseReserveTokens(ctx, max);
        expect(reserve).toBeGreaterThan(0);
        expect(reserve).toBeLessThan(ctx);
      }
    }
  });

  it("caps an explicit near-window maxTokens under the 80% ceiling", () => {
    // 58k on a 60k window would leave only ~3% for the prompt — clamp it.
    expect(deriveResponseReserveTokens(60_000, 58_000)).toBe(48_000);
  });

  it("caps the reserve at the absolute ceiling", () => {
    // DeepSeek V4.1 Flash: 1M window, 384k max output → threshold 936k.
    expect(deriveResponseReserveTokens(1_000_000, 384_000)).toBe(64_000);
    expect(deriveResponseReserveTokens(1_000_000, null)).toBe(64_000);
    expect(deriveResponseReserveTokens(200_000, 128_000)).toBe(64_000);
  });

  it("crosses from the 80 % cap to the 64k ceiling at an 80k window", () => {
    // 0.8 × 80k == 64k: both caps meet.
    expect(deriveResponseReserveTokens(80_000, 70_000)).toBe(64_000);
    expect(deriveResponseReserveTokens(79_000, 70_000)).toBe(63_200);
    // 20 % of the window reaches the ceiling at 320k, and stays below it at 300k.
    expect(deriveResponseReserveTokens(320_000, null)).toBe(64_000);
    expect(deriveResponseReserveTokens(300_000, null)).toBe(60_000);
    expect(deriveResponseReserveTokens(1_000_000, null)).toBe(64_000);
  });

  it("keeps the reserve below the window down to a 2-token window, and at 1 for a 1-token one", () => {
    expect(deriveResponseReserveTokens(2, null)).toBe(1);
    expect(deriveResponseReserveTokens(2, 1)).toBe(1);
    // No positive integer lies below 1: the documented `contextWindow >= 2` precondition.
    expect(deriveResponseReserveTokens(1, null)).toBe(1);
  });

  it("leaves reserves below the ceiling unchanged", () => {
    expect(deriveResponseReserveTokens(1_000_000, 32_000)).toBe(32_000);
    expect(deriveResponseReserveTokens(128_000, null)).toBe(25_600);
    expect(deriveResponseReserveTokens(200_000, 64_000)).toBe(64_000);
  });
});
