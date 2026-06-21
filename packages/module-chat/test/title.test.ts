// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { cleanTitle } from "../src/title.ts";

describe("cleanTitle", () => {
  it("returns a plain title unchanged", () => {
    expect(cleanTitle("Liste de mes agents")).toBe("Liste de mes agents");
  });

  it("strips wrapping straight and typographic quotes", () => {
    expect(cleanTitle('"Mon titre"')).toBe("Mon titre");
    expect(cleanTitle("«Mon titre»")).toBe("Mon titre");
    expect(cleanTitle("'Mon titre'")).toBe("Mon titre");
  });

  it("strips surrounding whitespace and trailing punctuation", () => {
    expect(cleanTitle("  Mon titre.  ")).toBe("Mon titre");
  });

  it("trims trailing period the model adds despite the instruction", () => {
    expect(cleanTitle("Résumé de la conversation.")).toBe("Résumé de la conversation");
  });

  it("caps the length at 80 characters", () => {
    const long = "a".repeat(200);
    expect(cleanTitle(long)).toHaveLength(80);
  });

  it("an empty / whitespace-only string collapses to empty", () => {
    expect(cleanTitle("   ")).toBe("");
    expect(cleanTitle('""')).toBe("");
  });
});
