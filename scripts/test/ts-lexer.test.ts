// SPDX-License-Identifier: Apache-2.0

/**
 * The primitives both module gates tokenize with. They decide where a literal ENDS: end one quote
 * too early and the code behind it reads as a string, too late and live code is blanked.
 */

import { describe, it, expect } from "bun:test";
import { scanQuoted, skipInterpolation } from "../lib/ts-lexer.ts";

/** Index of the first character AFTER the literal opened at 0. */
const endOf = (source: string, quote: string): number => scanQuoted(source, 0, quote);

describe("scanQuoted", () => {
  it("walks past a backslash-escaped quote to the real end", () => {
    // `"a\"b"` ending at the middle quote inverts every decision after it.
    const source = '"a\\"b" + rest';
    expect(endOf(source, '"')).toBe(6);
    expect(source.slice(0, 6)).toBe('"a\\"b"');
  });

  it("ends a plain literal at its closing quote", () => {
    expect(endOf("'ab' + rest", "'")).toBe(4);
  });

  it("gives a regex up at the newline, so an unclosed `/` costs one line", () => {
    const source = "/ab\nconst x = 1;\n";
    expect(endOf(source, "/")).toBe(3);
  });

  it("closes a regex at its own delimiter when it has one", () => {
    expect(endOf("/a\\/b/g", "/")).toBe(6);
  });

  it("returns the end of the source for an unterminated quote", () => {
    const source = '"never closed';
    expect(endOf(source, '"')).toBe(source.length);
  });
});

describe("skipInterpolation", () => {
  /** Index just past the `${…}` that starts at `start`. */
  const skip = (source: string): number => skipInterpolation(source, source.indexOf("${"));

  it("counts braces, so a `}` inside a string does not close the hole", () => {
    const source = '${cond ? "}" : x}tail';
    expect(skip(source)).toBe(source.indexOf("tail"));
  });

  it("closes on the outer brace of a nested object literal", () => {
    const source = "${{ a: { b: 1 } }}tail";
    expect(skip(source)).toBe(source.indexOf("tail"));
  });

  it("re-enters on a nested template and its own interpolation", () => {
    const source = "${`b${c}`}tail";
    expect(skip(source)).toBe(source.indexOf("tail"));
  });

  it("skips a single-quoted string holding a `}`", () => {
    const source = "${f('}')}tail";
    expect(skip(source)).toBe(source.indexOf("tail"));
  });

  it("skips a double-quoted string holding a `}`", () => {
    const source = '${f("}")}tail';
    expect(skip(source)).toBe(source.indexOf("tail"));
  });

  it("stops at the end of the source when the hole is never closed", () => {
    const source = "${unclosed";
    expect(skip(source)).toBe(source.length);
  });
});
