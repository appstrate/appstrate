// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for {@link derivePiCompactionSettings} — the pure mapping
 * from a resolved model's `(contextWindow, maxTokens)` to the Pi SDK's
 * `CompactionSettings`. Closes appstrate#445.
 *
 * Why we extracted this out of `executeSession`: the in-line call inside
 * the Pi SDK boot is impossible to unit-test (it would need a full
 * `createAgentSession` mock, which the `ScriptedPiRunner` helper bypasses
 * by overriding `executeSession` entirely). The pure function lets us
 * assert the contract directly without faking the SDK.
 */

import { describe, it, expect } from "bun:test";
import { derivePiCompactionSettings } from "../src/pi-runner.ts";

describe("derivePiCompactionSettings — reserveTokens", () => {
  it("uses model.maxTokens when populated", () => {
    const result = derivePiCompactionSettings({ contextWindow: 200_000, maxTokens: 64_000 }, {});
    if (result.enabled === false) throw new Error("compaction should be enabled");
    // Claude Sonnet 4.5 in thinking mode declares maxTokens=64000 —
    // reserveTokens MUST track this or the first post-compaction call
    // underflows and we see the same upstream 400.
    expect(result.reserveTokens).toBe(64_000);
  });

  it("falls back to 16384 when model.maxTokens is null", () => {
    const result = derivePiCompactionSettings({ contextWindow: 200_000, maxTokens: null }, {});
    if (result.enabled === false) throw new Error("compaction should be enabled");
    expect(result.reserveTokens).toBe(16_384);
  });

  it("falls back to 16384 when model.maxTokens is undefined", () => {
    const result = derivePiCompactionSettings({ contextWindow: 200_000 }, {});
    if (result.enabled === false) throw new Error("compaction should be enabled");
    expect(result.reserveTokens).toBe(16_384);
  });
});

describe("derivePiCompactionSettings — keepRecentTokens", () => {
  it("Claude 200k window → 20000 (floor wins, 10% == floor)", () => {
    // 10% × 200k = 20k, exactly at the floor.
    const result = derivePiCompactionSettings({ contextWindow: 200_000, maxTokens: 16_384 }, {});
    if (result.enabled === false) throw new Error("compaction should be enabled");
    expect(result.keepRecentTokens).toBe(20_000);
  });

  it("GPT-4.1 1M window → 100000 (10% × 1M)", () => {
    const result = derivePiCompactionSettings({ contextWindow: 1_000_000, maxTokens: 32_000 }, {});
    if (result.enabled === false) throw new Error("compaction should be enabled");
    expect(result.keepRecentTokens).toBe(100_000);
  });

  it("Gemini 2M window → 200000 (10% × 2M)", () => {
    const result = derivePiCompactionSettings({ contextWindow: 2_000_000, maxTokens: 8_192 }, {});
    if (result.enabled === false) throw new Error("compaction should be enabled");
    expect(result.keepRecentTokens).toBe(200_000);
  });

  it("100k window → 20000 (floor wins over 10% = 10k)", () => {
    // Floor protects small-window models from over-compaction: 10% would
    // strip recent context below a useful tail.
    const result = derivePiCompactionSettings({ contextWindow: 100_000, maxTokens: 4_096 }, {});
    if (result.enabled === false) throw new Error("compaction should be enabled");
    expect(result.keepRecentTokens).toBe(20_000);
  });

  it("null contextWindow → defaults to 200k path (keepRecentTokens=20000)", () => {
    const result = derivePiCompactionSettings({ contextWindow: null, maxTokens: 16_384 }, {});
    if (result.enabled === false) throw new Error("compaction should be enabled");
    expect(result.keepRecentTokens).toBe(20_000);
  });

  it("undefined contextWindow → defaults to 200k path (keepRecentTokens=20000)", () => {
    const result = derivePiCompactionSettings({ maxTokens: 16_384 }, {});
    if (result.enabled === false) throw new Error("compaction should be enabled");
    expect(result.keepRecentTokens).toBe(20_000);
  });
});

describe("derivePiCompactionSettings — MODEL_COMPACTION_ENABLED opt-out", () => {
  it("returns { enabled: false } when MODEL_COMPACTION_ENABLED=false", () => {
    // Mirrors the existing MODEL_RETRY_ENABLED escape hatch — operators
    // stacking external compaction middleware can disable Pi's pass.
    const result = derivePiCompactionSettings(
      { contextWindow: 200_000, maxTokens: 64_000 },
      { MODEL_COMPACTION_ENABLED: "false" },
    );
    expect(result).toEqual({ enabled: false });
  });

  it("ignores other values of MODEL_COMPACTION_ENABLED (only 'false' opts out)", () => {
    // Strict string match — anything but exactly "false" keeps compaction
    // on. Matches the retry flag's behaviour.
    const result = derivePiCompactionSettings(
      { contextWindow: 200_000, maxTokens: 16_384 },
      { MODEL_COMPACTION_ENABLED: "true" },
    );
    if (result.enabled === false) throw new Error("compaction should be enabled");
    expect(result.reserveTokens).toBe(16_384);
  });

  it("defaults to enabled when MODEL_COMPACTION_ENABLED is undefined", () => {
    const result = derivePiCompactionSettings({ contextWindow: 200_000, maxTokens: 16_384 }, {});
    if (result.enabled === false) throw new Error("compaction should be enabled");
    expect(result.reserveTokens).toBe(16_384);
    expect(result.keepRecentTokens).toBe(20_000);
  });
});

describe("derivePiCompactionSettings — full result shape", () => {
  it("returns both reserveTokens and keepRecentTokens for Claude Sonnet thinking", () => {
    // The original failure mode in appstrate#445: Claude Sonnet 4.5
    // thinking sets maxTokens=64000 on a 200k window. Without
    // reserveTokens tracking maxTokens, compaction reserves only the
    // SDK default (4k or whatever) and the next call underflows.
    const result = derivePiCompactionSettings({ contextWindow: 200_000, maxTokens: 64_000 }, {});
    expect(result).toEqual({
      enabled: true,
      reserveTokens: 64_000,
      keepRecentTokens: 20_000,
    });
  });
});
