// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { dedupeLabel } from "../src/dedupe-label.ts";

describe("dedupeLabel", () => {
  it("returns the base when free, else its first free ' (n)' form", () => {
    expect(dedupeLabel("Work", [])).toBe("Work");
    expect(dedupeLabel("Work", ["Work", "Work (2)"])).toBe("Work (3)");
  });

  it("with maxLength, cuts the base so every candidate fits", () => {
    const base = "a".repeat(10);
    expect(dedupeLabel(base, [], { maxLength: 10 })).toBe(base);
    expect(dedupeLabel(base, [base], { maxLength: 10 })).toBe("aaaaaa (2)");
    expect(dedupeLabel(base, [base, "aaaaaa (2)"], { maxLength: 10 })).toBe("aaaaaa (3)");
  });

  it("with maxLength, cuts an over-long base on its own", () => {
    expect(dedupeLabel("abcdef", [], { maxLength: 4 })).toBe("abcd");
  });

  it("with maxLength, keeps a base that fits, trailing whitespace included", () => {
    expect(dedupeLabel("ab ", [], { maxLength: 3 })).toBe("ab ");
  });

  it("with maxLength, cuts on a code-point boundary and trims the trailing space", () => {
    expect(dedupeLabel("ab 😀", [], { maxLength: 4 })).toBe("ab");
    expect(dedupeLabel("abc😀", [], { maxLength: 5 })).toBe("abc😀");
  });
});
