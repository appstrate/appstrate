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
  it("honours a usable explicit maxTokens verbatim (no behaviour change)", () => {
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
    // 95k on a 100k window would leave only 5% for the prompt — clamp it.
    expect(deriveResponseReserveTokens(100_000, 95_000)).toBe(80_000);
  });
});
