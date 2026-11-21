// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  formatCompactTokens,
  formatWindowPercent,
  fractionOfWindow,
} from "../src/context-window.ts";

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
    // On a 1 048 576-token window a run at 999 600 would otherwise render
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
