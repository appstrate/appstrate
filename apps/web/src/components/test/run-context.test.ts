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

const WINDOW = 200_000;

/**
 * A turn as the runner emits it today: it states the window it is running
 * against, on the same payload as the token counts.
 */
function turn(index: number, contextTokens: number, over: Partial<RunTurnRow> = {}): RunTurnRow {
  return { ...windowlessTurn(index, contextTokens), contextWindow: WINDOW, ...over };
}

/**
 * A turn with the window key genuinely ABSENT — a run predating the field, or a
 * runner that cannot size the model it is driving. Written as a separate
 * builder rather than `{ contextWindow: undefined }` because the contract under
 * test is the missing key, not a key holding `undefined`.
 */
function windowlessTurn(index: number, contextTokens: number): RunTurnRow {
  return {
    index,
    contextTokens,
    inputTokens: contextTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

describe("readRunContext — current vs peak", () => {
  it("follows a compaction DROP: `current` falls, `peak` remembers", () => {
    // The whole point of the metric: context is NOT monotone. After the runner
    // auto-compacts, the last turn is smaller than the peak — a gauge reading
    // the max would show a full bar on a run that just freed 150k of headroom.
    const reading = readRunContext([turn(0, 40_000), turn(1, 187_000), turn(2, 32_000)]);
    expect(reading?.current).toBe(32_000);
    expect(reading?.peak).toBe(187_000);
    expect(reading?.current).toBeLessThan(reading!.peak);
  });

  it("computes each share against the window, not against the run's own peak", () => {
    const reading = readRunContext([turn(0, 187_000), turn(1, 128_000)]);
    expect(reading?.currentFraction).toBeCloseTo(0.64, 10);
    expect(reading?.peakFraction).toBeCloseTo(0.935, 10);
  });
});

describe("readRunContext — where the denominator comes from", () => {
  it("takes the window off the turns themselves, with no run-level field involved", () => {
    const reading = readRunContext([turn(0, 128_000, { contextWindow: 1_000_000 })]);
    expect(reading?.window).toBe(1_000_000);
    expect(reading?.currentFraction).toBeCloseTo(0.128, 10);
  });

  it("uses the LAST stated window when the model was swapped mid-run", () => {
    // Swap DOWN, the case that decides the rule: the first window would size
    // `current` against a model that is no longer running, and the max would
    // print 19 % for a context one turn from compaction.
    const reading = readRunContext([
      turn(0, 900_000, { contextWindow: 1_000_000 }),
      turn(1, 190_000, { contextWindow: 200_000 }),
    ]);
    expect(reading?.window).toBe(200_000);
    expect(reading?.currentFraction).toBeCloseTo(0.95, 10);
    expect(reading?.currentFraction).not.toBeCloseTo(0.19, 2);

    // `peak` shares that ONE denominator, so on a swap down it exceeds it. The
    // fraction clamps; the raw count stays honest, exactly as for a window that
    // disagrees with what the provider later billed.
    expect(reading?.peak).toBe(900_000);
    expect(reading?.peakFraction).toBe(1);
  });

  it("does not let a turn stating no window reset the last statement", () => {
    // Losing the ability to size the model is not a statement that the window
    // shrank, so the previous one stands.
    const reading = readRunContext([turn(0, 50_000), windowlessTurn(1, 60_000)]);
    expect(reading?.window).toBe(WINDOW);
    expect(reading?.current).toBe(60_000);
  });

  it("skips a malformed window and keeps the last USABLE statement", () => {
    const reading = readRunContext([
      turn(0, 50_000),
      turn(1, 60_000, { contextWindow: 0 }),
      turn(2, 70_000, { contextWindow: Number.NaN }),
    ]);
    expect(reading?.window).toBe(WINDOW);
    expect(reading?.current).toBe(70_000);
  });
});

describe("readRunContext — nothing truthful to render", () => {
  it("returns null for a run with no turn breadcrumbs (no numerator)", () => {
    expect(readRunContext([])).toBeNull();
    expect(readRunContext(undefined)).toBeNull();
  });

  it("returns null when no turn states a window, even with real counts", () => {
    // A raw 128 430 with nothing to divide it by informs nobody — the header
    // drops it rather than showing an uninterpretable number. There is no
    // second source to fall back on any more: the run row no longer carries a
    // window, so a series that states none leaves the reading unbuildable.
    expect(readRunContext([windowlessTurn(0, 128_430)])).toBeNull();
    expect(readRunContext([windowlessTurn(0, 40_000), windowlessTurn(1, 128_430)])).toBeNull();
  });

  it("returns null when every stated window is non-positive or non-finite", () => {
    expect(readRunContext([turn(0, 100, { contextWindow: 0 })])).toBeNull();
    expect(readRunContext([turn(0, 100, { contextWindow: -1 })])).toBeNull();
    expect(readRunContext([turn(0, 100, { contextWindow: Number.NaN })])).toBeNull();
  });

  it("returns null when no turn carries a usable reading", () => {
    // A settled turn CAN report zero: the runner emits the breadcrumb as soon as
    // the input OR the output delta is positive, and `contextTokens` is built
    // from the input side only — so a provider reporting completion tokens but
    // omitting the prompt count produces real turns whose context reads zero.
    // Rendering them is the `0 / 200k`, empty-bar lie the module forbids.
    expect(readRunContext([turn(0, 0)])).toBeNull();
    expect(readRunContext([turn(0, 0), turn(1, 0)])).toBeNull();
  });
});

describe("readRunContext — turns that measured nothing", () => {
  it("excludes a zero-context turn from BOTH readings", () => {
    const reading = readRunContext([turn(0, 190_000), turn(1, 0)]);
    expect(reading?.current).toBe(190_000);
    expect(reading?.peak).toBe(190_000);
    expect(reading?.currentFraction).toBeCloseTo(0.95, 10);
  });

  it("reads `current` off the last USABLE turn, not off the last turn", () => {
    // The documented semantic refinement: slightly stale beats plainly false.
    const reading = readRunContext([turn(0, 187_000), turn(1, 128_000), turn(2, 0)]);
    expect(reading?.current).toBe(128_000);
    expect(reading?.peak).toBe(187_000);
  });

  it("treats a malformed count the same way as a zero", () => {
    const reading = readRunContext([turn(0, 128_000), turn(1, Number.NaN)]);
    expect(reading?.current).toBe(128_000);
    expect(reading?.peak).toBe(128_000);
  });

  it("still takes its window from a turn that measured nothing", () => {
    // The window statement is independent of the token measurement: a turn that
    // reported no prompt count still knows which model it ran against.
    const reading = readRunContext([
      windowlessTurn(0, 128_000),
      turn(1, 0, { contextWindow: 1_000_000 }),
    ]);
    expect(reading?.window).toBe(1_000_000);
    expect(reading?.current).toBe(128_000);
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
    const reading = readRunContext([turn(0, 210_000)]);
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
