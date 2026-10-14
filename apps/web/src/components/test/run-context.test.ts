// SPDX-License-Identifier: Apache-2.0

/**
 * The context-window derivation behind the per-turn table
 * (`run-execution-tab.tsx`): which window applies, and the share of it a turn
 * occupies. Pure, so it needs no DOM.
 */

import { describe, it, expect } from "bun:test";
import type { RunTurnRow } from "../log-utils.ts";
import { fractionOfWindow, formatWindowPercent, readRunContext } from "../run-context.ts";

const WINDOW = 200_000;

/**
 * A turn as the runner emits it: it states the window it is running against,
 * on the same payload as the token counts.
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

describe("readRunContext — where the denominator comes from", () => {
  it("takes the window off the turns themselves, with no run-level field involved", () => {
    const reading = readRunContext([turn(0, 128_000, { contextWindow: 1_000_000 })]);
    expect(reading?.window).toBe(1_000_000);
  });

  it("uses the LAST stated window when the model was swapped mid-run", () => {
    // Swap DOWN, the case that decides the rule: the first window would size
    // the latest turn against a model that is no longer running, and the max
    // would print 19 % for a context one turn from compaction.
    const reading = readRunContext([
      turn(0, 900_000, { contextWindow: 1_000_000 }),
      turn(1, 190_000, { contextWindow: 200_000 }),
    ]);
    expect(reading?.window).toBe(200_000);
    expect(fractionOfWindow(190_000, reading!.window)).toBeCloseTo(0.95, 10);
    // The earlier turn exceeds that single window: its share clamps.
    expect(fractionOfWindow(900_000, reading!.window)).toBe(1);
  });

  it("does not let a turn stating no window reset the last statement", () => {
    // Losing the ability to size the model is not a statement that the window
    // shrank, so the previous one stands.
    const reading = readRunContext([turn(0, 50_000), windowlessTurn(1, 60_000)]);
    expect(reading?.window).toBe(WINDOW);
  });

  it("skips a malformed window and keeps the last USABLE statement", () => {
    const reading = readRunContext([
      turn(0, 50_000),
      turn(1, 60_000, { contextWindow: 0 }),
      turn(2, 70_000, { contextWindow: Number.NaN }),
    ]);
    expect(reading?.window).toBe(WINDOW);
  });

  it("still takes its window from a turn that measured nothing", () => {
    // The window statement is independent of the token measurement: a turn that
    // reported no prompt count still knows which model it ran against.
    const reading = readRunContext([
      windowlessTurn(0, 128_000),
      turn(1, 0, { contextWindow: 1_000_000 }),
    ]);
    expect(reading?.window).toBe(1_000_000);
  });
});

describe("readRunContext — nothing truthful to measure against", () => {
  it("returns null for a run with no turn breadcrumbs", () => {
    expect(readRunContext([])).toBeNull();
    expect(readRunContext(undefined)).toBeNull();
  });

  it("returns null when no turn states a window, even with real counts", () => {
    // A raw 128 430 with nothing to divide it by says nothing about headroom,
    // and the run row carries no window to fall back on.
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
    expect(readRunContext([turn(0, 0)])).toBeNull();
    expect(readRunContext([turn(0, 0), turn(1, 0)])).toBeNull();
    expect(readRunContext([turn(0, Number.NaN)])).toBeNull();
  });

  it("keeps the window as soon as one turn carries a usable reading", () => {
    expect(readRunContext([turn(0, 190_000), turn(1, 0)])?.window).toBe(WINDOW);
    expect(readRunContext([turn(0, 128_000), turn(1, Number.NaN)])?.window).toBe(WINDOW);
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
