// SPDX-License-Identifier: Apache-2.0

/**
 * The title a conversation takes from its first user message: whole when
 * short, cut at a word boundary when long — never in the middle of a word,
 * unless the boundary would throw most of the message away.
 */

import { describe, it, expect } from "bun:test";
import { titleFromText } from "../src/persistence.ts";

describe("the title derived from a first message", () => {
  it("is null for a message with no text", () => {
    expect(titleFromText("")).toBeNull();
  });

  it("keeps a message of up to 60 characters whole", () => {
    const text = "X".repeat(60);
    expect(titleFromText(text)).toBe(text);
  });

  it("cuts a long message at a word boundary, not inside a word", () => {
    // The 57-character head ends inside "autre": it used to read "…d'aut…".
    expect(
      titleFromText(
        "Réponds simplement par le mot OK, sans rien ajouter d'autre que ce mot, et rien de plus.",
      ),
    ).toBe("Réponds simplement par le mot OK, sans rien ajouter…");
  });

  it("keeps the head as is when it already ends on a word", () => {
    const head = `${"A".repeat(28)} ${"b".repeat(28)}`;
    expect(titleFromText(`${head} ${"c".repeat(20)}`)).toBe(`${head}…`);
  });

  it("cuts inside a long token rather than keep only the short word before it", () => {
    // The only boundary is after "Regarde": cutting there would leave "Regarde…".
    const text = `Regarde https://example.com/${"a".repeat(80)}`;
    expect(titleFromText(text)).toBe(`${text.slice(0, 57)}…`);
  });

  it("cuts one unbroken word where the head ends", () => {
    expect(titleFromText("X".repeat(80))).toBe(`${"X".repeat(57)}…`);
  });

  it("upper-cases a leading lowercase letter", () => {
    expect(titleFromText("bonjour le monde")).toBe("Bonjour le monde");
    expect(titleFromText("élan")).toBe("Élan");
    expect(titleFromText("ibrahim")).toBe("Ibrahim");
  });

  it("keeps a brand-style lowercase start (second letter a capital)", () => {
    expect(titleFromText("iPhone ne marche plus")).toBe("iPhone ne marche plus");
    expect(titleFromText("eBay")).toBe("eBay");
  });

  it("leaves a capital or a non-letter start unchanged", () => {
    for (const text of ["Bonjour", "42 raisons", "😀 salut", '"citation"', "¿qué?"]) {
      expect(titleFromText(text)).toBe(text);
    }
  });

  it("still truncates a long lowercase message after capitalising it", () => {
    const text = `${"a".repeat(28)} ${"b".repeat(28)} ${"c".repeat(20)}`;
    expect(titleFromText(text)).toBe(`A${"a".repeat(27)} ${"b".repeat(28)}…`);
  });
});
