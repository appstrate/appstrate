// SPDX-License-Identifier: Apache-2.0

/**
 * RFC 9110 §13.1.2 conditional-request evaluation, shared by the OpenAPI spec
 * route and the package file explorer. The two used to carry a copy each; these
 * cases are the union of what both relied on, plus the one parameter that made
 * them look different (`allowWildcard`).
 */

import { describe, it, expect } from "bun:test";
import { ifNoneMatchSatisfied } from "../../src/lib/if-none-match.ts";

describe("ifNoneMatchSatisfied", () => {
  it("rejects a missing or empty header", () => {
    expect(ifNoneMatchSatisfied(undefined, '"abc"')).toBe(false);
    expect(ifNoneMatchSatisfied("", '"abc"')).toBe(false);
  });

  it("matches an exact tag", () => {
    expect(ifNoneMatchSatisfied('"abc"', '"abc"')).toBe(true);
    expect(ifNoneMatchSatisfied('"other"', '"abc"')).toBe(false);
  });

  it("does not treat a substring as a match", () => {
    // The quotes are part of the comparison, so a prefix cannot pass.
    expect(ifNoneMatchSatisfied('"ab"', '"abc"')).toBe(false);
    expect(ifNoneMatchSatisfied('"abcd"', '"abc"')).toBe(false);
  });

  it("compares weakly — W/ on either side is the same tag", () => {
    expect(ifNoneMatchSatisfied('W/"abc"', '"abc"')).toBe(true);
    expect(ifNoneMatchSatisfied('"abc"', 'W/"abc"')).toBe(true);
    expect(ifNoneMatchSatisfied('W/"abc"', 'W/"abc"')).toBe(true);
    // Only a LEADING `W/` is a weakness marker.
    expect(ifNoneMatchSatisfied('"W/abc"', '"abc"')).toBe(false);
  });

  it("accepts any member of a comma-separated list, with surrounding spaces", () => {
    expect(ifNoneMatchSatisfied('"x", "abc" ,"y"', '"abc"')).toBe(true);
    expect(ifNoneMatchSatisfied('  W/"abc"  ', '"abc"')).toBe(true);
    expect(ifNoneMatchSatisfied('"x","y"', '"abc"')).toBe(false);
  });

  it("honours `*` by default, including inside a list", () => {
    expect(ifNoneMatchSatisfied("*", '"abc"')).toBe(true);
    expect(ifNoneMatchSatisfied('"x", *', '"abc"')).toBe(true);
  });

  it("refuses `*` under allowWildcard: false, without disabling real tags", () => {
    // The pre-read short-circuit on the file-content route: `*` means "if any
    // current representation exists", which the server cannot affirm before it
    // knows the path is in the artifact — answering 304 there would tell the
    // caller a file exists. A concrete tag still matches, because it proves the
    // client already got a 200 for that exact representation.
    expect(ifNoneMatchSatisfied("*", '"abc"', { allowWildcard: false })).toBe(false);
    expect(ifNoneMatchSatisfied('"x", *', '"abc"', { allowWildcard: false })).toBe(false);
    expect(ifNoneMatchSatisfied('"abc", *', '"abc"', { allowWildcard: false })).toBe(true);
    expect(ifNoneMatchSatisfied("*", '"abc"', { allowWildcard: true })).toBe(true);
    expect(ifNoneMatchSatisfied("*", '"abc"', {})).toBe(true);
  });
});
