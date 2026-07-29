// SPDX-License-Identifier: Apache-2.0

/**
 * The shared context derivation (#1046) — the single source both the run-header
 * gauge and the Info tab's per-turn table read from. Pure, so it needs no DOM.
 */

import { describe, it, expect } from "bun:test";
import type { RunTurnRow } from "../log-utils.ts";
import {
  fractionOfWindow,
  formatCompactTokens,
  formatWindowPercent,
  readRunContext,
} from "../run-context.ts";

function turn(index: number, contextTokens: number): RunTurnRow {
  return {
    index,
    contextTokens,
    inputTokens: contextTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

const WINDOW = 200_000;

describe("readRunContext — current vs peak", () => {
  it("reads `current` off the LAST turn and `peak` off the whole series", () => {
    const reading = readRunContext([turn(0, 40_000), turn(1, 128_000)], WINDOW, null);
    expect(reading?.current).toBe(128_000);
    expect(reading?.peak).toBe(128_000);
  });

  it("follows a compaction DROP: `current` falls, `peak` remembers", () => {
    // The whole point of the metric: context is NOT monotone. After the runner
    // auto-compacts, the last turn is smaller than the peak — a gauge reading
    // the max would show a full bar on a run that just freed 150k of headroom.
    const reading = readRunContext(
      [turn(0, 40_000), turn(1, 187_000), turn(2, 32_000)],
      WINDOW,
      null,
    );
    expect(reading?.current).toBe(32_000);
    expect(reading?.peak).toBe(187_000);
    expect(reading?.current).toBeLessThan(reading!.peak);
  });

  it("computes each share against the window, not against the run's own peak", () => {
    const reading = readRunContext([turn(0, 187_000), turn(1, 128_000)], WINDOW, null);
    expect(reading?.currentFraction).toBeCloseTo(0.64, 10);
    expect(reading?.peakFraction).toBeCloseTo(0.935, 10);
  });
});

describe("readRunContext — nothing truthful to render", () => {
  it("returns null for a run with no turn breadcrumbs (no numerator)", () => {
    expect(readRunContext([], WINDOW, 136_000)).toBeNull();
    expect(readRunContext(undefined, WINDOW, 136_000)).toBeNull();
  });

  it("returns null when the window is unknown, even with real turns", () => {
    // A raw 128 430 with nothing to divide it by informs nobody — the header
    // drops it rather than showing an uninterpretable number.
    const turns = [turn(0, 128_430)];
    expect(readRunContext(turns, null, null)).toBeNull();
    expect(readRunContext(turns, undefined, null)).toBeNull();
  });

  it("returns null for a non-positive or non-finite window", () => {
    expect(readRunContext([turn(0, 100)], 0, null)).toBeNull();
    expect(readRunContext([turn(0, 100)], -1, null)).toBeNull();
    expect(readRunContext([turn(0, 100)], Number.NaN, null)).toBeNull();
  });

  it("returns null when no turn carries a usable reading", () => {
    // A settled turn CAN report zero: the runner emits the breadcrumb as soon as
    // the input OR the output delta is positive, and `contextTokens` is built
    // from the input side only — so a provider reporting completion tokens but
    // omitting the prompt count produces real turns whose context reads zero.
    // Rendering them is the `0 / 200k`, empty-bar lie the module forbids.
    expect(readRunContext([turn(0, 0)], WINDOW, null)).toBeNull();
    expect(readRunContext([turn(0, 0), turn(1, 0)], WINDOW, null)).toBeNull();
  });
});

describe("readRunContext — turns that measured nothing", () => {
  it("excludes a zero-context turn from BOTH readings", () => {
    const reading = readRunContext([turn(0, 190_000), turn(1, 0)], WINDOW, null);
    expect(reading?.current).toBe(190_000);
    expect(reading?.peak).toBe(190_000);
    expect(reading?.currentFraction).toBeCloseTo(0.95, 10);
  });

  it("reads `current` off the last USABLE turn, not off the last turn", () => {
    // The documented semantic refinement: slightly stale beats plainly false.
    const reading = readRunContext([turn(0, 187_000), turn(1, 128_000), turn(2, 0)], WINDOW, null);
    expect(reading?.current).toBe(128_000);
    expect(reading?.peak).toBe(187_000);
  });

  it("treats a malformed count the same way as a zero", () => {
    const reading = readRunContext([turn(0, 128_000), turn(1, Number.NaN)], WINDOW, null);
    expect(reading?.current).toBe(128_000);
    expect(reading?.peak).toBe(128_000);
  });
});

describe("readRunContext — compaction threshold", () => {
  it("carries the marker as a share of the window when it is inside it", () => {
    const reading = readRunContext([turn(0, 128_000)], WINDOW, 136_000);
    expect(reading?.threshold).toBe(136_000);
    expect(reading?.thresholdFraction).toBeCloseTo(0.68, 10);
  });

  it("drops the marker — not the reading — when the threshold is absent", () => {
    const reading = readRunContext([turn(0, 128_000)], WINDOW, null);
    expect(reading).not.toBeNull();
    expect(reading?.threshold).toBeNull();
    expect(reading?.thresholdFraction).toBeNull();
  });

  it("drops a threshold at or past the window: it marks nothing a full bar does not", () => {
    expect(readRunContext([turn(0, 1)], WINDOW, WINDOW)?.threshold).toBeNull();
    expect(readRunContext([turn(0, 1)], WINDOW, WINDOW + 1)?.threshold).toBeNull();
    expect(readRunContext([turn(0, 1)], WINDOW, 0)?.threshold).toBeNull();
  });
});

describe("fractionOfWindow", () => {
  it("is a plain share of the denominator", () => {
    expect(fractionOfWindow(50, 200)).toBe(0.25);
  });

  it("clamps past the denominator — a bar cannot overflow its track", () => {
    expect(fractionOfWindow(300, 200)).toBe(1);
  });

  it("degrades to 0 rather than Infinity/NaN on a useless denominator", () => {
    expect(fractionOfWindow(50, 0)).toBe(0);
    expect(fractionOfWindow(Number.NaN, 200)).toBe(0);
  });

  it("clamps the reading's fractions too, so a stale window cannot print 103 %", () => {
    const reading = readRunContext([turn(0, 210_000)], WINDOW, null);
    expect(reading?.current).toBe(210_000); // the raw count is NOT clamped
    expect(reading?.currentFraction).toBe(1);
  });
});

describe("formatCompactTokens", () => {
  it("keeps sub-thousand counts exact and rounds thousands to `k`", () => {
    expect(formatCompactTokens(0)).toBe("0");
    expect(formatCompactTokens(999)).toBe("999");
    expect(formatCompactTokens(128_430)).toBe("128k");
    expect(formatCompactTokens(200_000)).toBe("200k");
  });

  it("switches to `M` at a million — 1M windows are shipping models", () => {
    expect(formatCompactTokens(1_000_000)).toBe("1.0M");
    expect(formatCompactTokens(1_500_000)).toBe("1.5M");
  });

  it("promotes at the ROUNDING boundary, never emitting the `1000k` it rejects", () => {
    // On a 1 048 576-token window a run at 999 600 used to render
    // `1000k / 1.0M` — two magnitudes side by side, and the exact string the
    // function's own docstring calls unreadable.
    expect(formatCompactTokens(999_400)).toBe("999k");
    expect(formatCompactTokens(999_500)).toBe("1.0M");
    expect(formatCompactTokens(999_600)).toBe("1.0M");
    expect(formatCompactTokens(1_048_576)).toBe("1.0M");
  });

  it("never renders a misleading figure for malformed input", () => {
    expect(formatCompactTokens(Number.NaN)).toBe("0");
    expect(formatCompactTokens(-5)).toBe("0");
  });
});

describe("formatWindowPercent", () => {
  it("renders a whole percentage in English", () => {
    expect(formatWindowPercent(0.64, "en")).toBe("64%");
  });

  it("follows the locale's own spacing rule rather than a hardcoded one", () => {
    // French inserts a (narrow) no-break space before the sign; asserting the
    // exact codepoint would pin the test to an ICU version, so assert the rule.
    const fr = formatWindowPercent(0.64, "fr");
    expect(fr).toContain("64");
    expect(fr).toEndWith("%");
    expect(fr).not.toBe(formatWindowPercent(0.64, "en"));
  });
});
