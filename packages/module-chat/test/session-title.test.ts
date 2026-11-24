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

  it("opens on a capital letter", () => {
    expect(titleFromText("comment résumer ce fichier ?")).toBe("Comment résumer ce fichier ?");
    expect(titleFromText("été 2026 : le bilan")).toBe("Été 2026 : le bilan");
  });

  it("leaves a title that does not open on a lowercase letter as it is", () => {
    expect(titleFromText("Déjà en majuscule")).toBe("Déjà en majuscule");
    expect(titleFromText("2026 en chiffres")).toBe("2026 en chiffres");
    expect(titleFromText("« citation »")).toBe("« citation »");
  });

  it("capitalises a long message before cutting it", () => {
    expect(
      titleFromText(
        "réponds simplement par le mot OK, sans rien ajouter d'autre que ce mot, et rien de plus.",
      ),
    ).toBe("Réponds simplement par le mot OK, sans rien ajouter…");
  });

  it("cuts one unbroken word where the head ends", () => {
    expect(titleFromText("X".repeat(80))).toBe(`${"X".repeat(57)}…`);
  });
});
