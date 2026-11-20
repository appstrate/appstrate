// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  formatCompactTokens,
  formatTokenFigure,
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
  const nbsp = "\u00a0";

  it("keeps sub-thousand counts exact and rounds thousands, in the UI language", () => {
    expect(formatCompactTokens(0, "en")).toBe("0");
    expect(formatCompactTokens(999, "en")).toBe("999");
    expect(formatCompactTokens(128_430, "en")).toBe("128K");
    expect(formatCompactTokens(128_430, "fr")).toBe(`128${nbsp}k`);
  });

  it("switches to a million, with the language's decimal separator", () => {
    expect(formatCompactTokens(1_000_000, "en")).toBe("1M");
    expect(formatCompactTokens(1_500_000, "en")).toBe("1.5M");
    expect(formatCompactTokens(1_000_000, "fr")).toBe(`1${nbsp}M`);
    expect(formatCompactTokens(1_500_000, "fr")).toBe(`1,5${nbsp}M`);
  });

  it("promotes at the ROUNDING boundary, never emitting `1000K`", () => {
    expect(formatCompactTokens(999_400, "en")).toBe("999K");
    expect(formatCompactTokens(999_600, "en")).toBe("1M");
    expect(formatCompactTokens(1_048_576, "en")).toBe("1M");
  });

  it("never renders a misleading figure for malformed input", () => {
    expect(formatCompactTokens(Number.NaN, "en")).toBe("0");
    expect(formatCompactTokens(-5, "en")).toBe("0");
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

describe("formatTokenFigure", () => {
  it("marks an assumed window and leaves a declared one as is", () => {
    expect(formatTokenFigure(128_000, false, "en")).toBe("128K");
    expect(formatTokenFigure(128_000, undefined, "en")).toBe("128K");
    expect(formatTokenFigure(128_000, true, "en")).toBe("≈\u00a0128K");
    expect(formatTokenFigure(128_000, true, "fr")).toBe(
      `≈\u00a0${formatCompactTokens(128_000, "fr")}`,
    );
  });
});
