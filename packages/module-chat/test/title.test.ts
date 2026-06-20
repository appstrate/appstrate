// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { cleanTitle } from "../src/title.ts";

describe("cleanTitle", () => {
  test("returns a plain title unchanged", () => {
    expect(cleanTitle("Liste de mes agents")).toBe("Liste de mes agents");
  });

  test("strips wrapping straight and typographic quotes", () => {
    expect(cleanTitle('"Mon titre"')).toBe("Mon titre");
    expect(cleanTitle("«Mon titre»")).toBe("Mon titre");
    expect(cleanTitle("'Mon titre'")).toBe("Mon titre");
  });

  test("strips surrounding whitespace and trailing punctuation", () => {
    expect(cleanTitle("  Mon titre.  ")).toBe("Mon titre");
  });

  test("trims trailing period the model adds despite the instruction", () => {
    expect(cleanTitle("Résumé de la conversation.")).toBe("Résumé de la conversation");
  });

  test("caps the length at 80 characters", () => {
    const long = "a".repeat(200);
    expect(cleanTitle(long)).toHaveLength(80);
  });

  test("an empty / whitespace-only string collapses to empty", () => {
    expect(cleanTitle("   ")).toBe("");
    expect(cleanTitle('""')).toBe("");
  });
});
