// SPDX-License-Identifier: Apache-2.0

/** The identity editor: which icon forms it offers, and the whole colour palette. */

import { describe, expect, it } from "bun:test";
import type { IconForm } from "@appstrate/core/appearance";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";
import { AppearancePicker, type AppearanceValue } from "../appearance-picker.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const EMPTY: AppearanceValue = { icon: null, color: null };

function picker(allow: readonly IconForm[], value: AppearanceValue = EMPTY): string {
  return render(
    <AppearancePicker
      value={value}
      onChange={() => {}}
      allow={allow}
      seed="spc_0123456789"
      label="Équipe Produit"
    />,
  );
}

/** The labels of the icon form tabs, in order. */
function tabs(html: string): string[] {
  return [...html.matchAll(/data-state="(?:on|off)" role="radio"[^>]*>([^<]+)</g)].map(
    (match) => match[1]!,
  );
}

describe("AppearancePicker", () => {
  it("offers a tab per allowed icon form", () => {
    expect(tabs(picker(["lucide", "emoji", "image"]))).toEqual(["Icône", "Emoji", "Image"]);
    expect(tabs(picker(["emoji", "image"]))).toEqual(["Emoji", "Image"]);
  });

  it("draws no tabs for a single form", () => {
    const html = picker(["lucide"]);
    expect(tabs(html)).toEqual([]);
    expect(html).toContain("Choisir une icône");
    expect(html).not.toContain("Importer une image");
  });

  it("opens on the form of the stored icon", () => {
    const html = picker(["lucide", "emoji"], { icon: "emoji:🚜", color: null });
    expect(html).toMatch(/data-state="on"[^>]*>Emoji</);
    expect(html).toContain("Choisir un emoji");
    expect(html).toContain("Retirer l’icône");
  });

  it("names the icon group by its label and the form tabs by theirs", () => {
    const html = picker(["lucide", "emoji"]);
    const labelId = html.match(/<label[^>]*id="([^"]+)"[^>]*>Icône</)?.[1];
    expect(labelId).toBeDefined();
    expect(html).toContain(`role="group" aria-labelledby="${labelId}"`);
    expect(html).toMatch(/role="radiogroup"[^>]*aria-label="Type d’icône"/);
  });

  it("names the emoji trigger by the current emoji", () => {
    const html = picker(["emoji"], { icon: "emoji:🚜", color: null });
    expect(html).toContain('<span class="text-base leading-none">🚜</span>');
  });

  it("offers the nine colours and the automatic one", () => {
    const html = picker(["lucide"]);
    const values = [...html.matchAll(/role="radio"[^>]*value="([^"]+)"/g)].map((m) => m[1]);
    expect(values).toEqual([
      "auto",
      "neutral",
      "blue",
      "emerald",
      "violet",
      "amber",
      "rose",
      "cyan",
      "pink",
      "orange",
    ]);
    expect(html).toContain("Automatique");
    expect(html).toContain("Fuchsia");
  });

  it("checks the automatic colour for a null colour, the stored one otherwise", () => {
    expect(picker(["lucide"])).toMatch(/aria-checked="true"[^>]*value="auto"/);
    expect(picker(["lucide"], { icon: null, color: "amber" })).toMatch(
      /aria-checked="true"[^>]*value="amber"/,
    );
  });
});
