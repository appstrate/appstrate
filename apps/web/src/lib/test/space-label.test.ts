// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../i18n.ts";
import { spaceLabel } from "../space-label.ts";

await i18nReady;
await i18n.changeLanguage("fr");

describe("spaceLabel", () => {
  it("calls a team space what its members named it", () => {
    expect(spaceLabel({ personal: false, name: "Studio" }, i18n.t)).toBe("Studio");
  });

  it("calls the caller's own personal space theirs, never by its stored name", () => {
    expect(spaceLabel({ personal: true, name: "Stored", orphaned_at: null }, i18n.t)).toBe(
      "Mon espace",
    );
  });

  it("never calls an orphaned personal space the reader's own", () => {
    // Listed to owners and admins only, and always somebody else's.
    expect(
      spaceLabel(
        { personal: true, name: "Mon espace", orphaned_at: "2026-10-01T00:00:00Z" },
        i18n.t,
      ),
    ).toBe("Espace personnel d'un ancien membre");
  });
});
