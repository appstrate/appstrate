// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../i18n.ts";
import { spaceLabel, spaceTile } from "../space-label.ts";

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

describe("spaceTile", () => {
  const viewer = { id: "usr_me", name: "Ada Lovelace" };
  const space = { id: "spc_1", name: "Studio", icon: "lucide:rocket", color: "violet" };

  it("draws a team space by its own icon and colour", () => {
    expect(spaceTile({ ...space, personal: false }, viewer)).toEqual({
      icon: "lucide:rocket",
      color: "violet",
      seed: "spc_1",
      label: "Studio",
    });
  });

  it("draws the viewer's own personal space as the viewer", () => {
    expect(
      spaceTile({ ...space, icon: null, color: null, personal: true, orphaned_at: null }, viewer),
    ).toEqual({ icon: null, color: null, seed: "usr_me", label: "Ada Lovelace" });
  });

  it("draws the own personal space as an unnamed person while no session is known", () => {
    expect(
      spaceTile({ ...space, icon: null, color: null, personal: true, orphaned_at: null }, null),
    ).toEqual({ icon: "lucide:user", color: null, seed: "spc_1", label: "Studio" });
  });

  it("draws an orphaned personal space as a person who is gone, never as the viewer", () => {
    expect(
      spaceTile(
        { ...space, icon: null, color: null, personal: true, orphaned_at: "2026-10-01T00:00:00Z" },
        viewer,
      ),
    ).toEqual({ icon: "lucide:user-x", color: null, seed: "spc_1", label: "Studio" });
  });
});
