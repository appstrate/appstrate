// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { matchesSearch } from "../strings.ts";

describe("matchesSearch", () => {
  it("matches every row while the search is empty or blank", () => {
    expect(matchesSearch("", ["Gmail"])).toBe(true);
    expect(matchesSearch("   ", [])).toBe(true);
  });

  it("finds the search in any text, ignoring case and surrounding blanks", () => {
    expect(matchesSearch("  MAIL ", ["@appstrate/gmail", "Gmail"])).toBe(true);
    expect(matchesSearch("drive", ["@appstrate/gmail", "Gmail"])).toBe(false);
  });

  it("reads lists of texts (keywords) and skips missing ones", () => {
    expect(matchesSearch("inbox", [null, undefined, ["email", "Inbox"]])).toBe(true);
    expect(matchesSearch("inbox", [null, undefined, []])).toBe(false);
  });
});
