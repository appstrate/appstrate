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

/** The labels of the icon form tabs, in order (each trigger draws an icon before its label). */
function tabs(html: string): string[] {
  return [...html.matchAll(/role="tab"[^>]*>(?:<svg[^>]*>.*?<\/svg>)?([^<]+)</g)].map(
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
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('role="tabpanel"');
    expect(html).toContain("Choisir une icône");
    expect(html).not.toContain("Importer une image");
  });

  it("opens on the form of the stored icon", () => {
    const html = picker(["lucide", "emoji"], { icon: "emoji:🚜", color: null });
    expect(html).toMatch(
      /role="tab"[^>]*aria-selected="true"[^>]*data-state="active"[^>]*>(?:<svg[^>]*>.*?<\/svg>)?Emoji</,
    );
    expect(html).toMatch(
      /role="tab"[^>]*aria-selected="false"[^>]*>(?:<svg[^>]*>.*?<\/svg>)?Icône</,
    );
    expect(html).toContain("Changer d’emoji");
    expect(html).not.toContain("Choisir un emoji");
    expect(html).toContain("Retirer l’icône");
  });

  it("draws no « Icône » or « Couleur » heading, and names the palette and the tabs", () => {
    const html = picker(["lucide", "emoji"]);
    // The only « Couleur » / « Icône » texts are the accessible names and the tab.
    expect(html).not.toMatch(/>\s*Couleur\s*</);
    expect(html.match(/>Icône</g)).toHaveLength(1);
    expect(html).not.toContain('role="group"');
    expect(html).toMatch(/role="radiogroup"[^>]*aria-label="Couleur"/);
    expect(html).toMatch(/role="tablist"[^>]*aria-label="Type d’icône"/);
  });

  it("stacks the preview, the palette, then the icon forms", () => {
    const html = picker(["lucide", "emoji"], { icon: "lucide:bot", color: null });
    const preview = html.indexOf("Équipe Produit");
    const palette = html.indexOf('role="radiogroup"');
    const tablist = html.indexOf('role="tablist"');
    const field = html.indexOf('role="combobox"');
    expect(preview).toBeGreaterThan(-1);
    expect(palette).toBeGreaterThan(preview);
    expect(tablist).toBeGreaterThan(palette);
    expect(field).toBeGreaterThan(tablist);
    // Single form: the field sits directly under the palette.
    const single = picker(["lucide"]);
    expect(single.indexOf('role="combobox"')).toBeGreaterThan(single.indexOf('role="radiogroup"'));
  });

  it("draws the removal inside the preview card, only for a set icon the viewer can change", () => {
    const withIcon = picker(["lucide"], { icon: "lucide:bot", color: null });
    const removal = withIcon.indexOf("Retirer l’icône");
    expect(removal).toBeGreaterThan(withIcon.indexOf("Équipe Produit"));
    expect(removal).toBeLessThan(withIcon.indexOf('role="radiogroup"'));
    expect(picker(["lucide"])).not.toContain("Retirer l’icône");
    const locked = render(
      <AppearancePicker
        value={{ icon: "lucide:bot", color: null }}
        onChange={() => {}}
        allow={["lucide"]}
        seed="spc_0123456789"
        label="Équipe Produit"
        disabled
      />,
    );
    expect(locked).not.toContain("Retirer l’icône");
  });

  it("names the Lucide combobox by « Icône » and its current value", () => {
    const html = picker(["lucide"], { icon: "lucide:calendar-clock", color: null });
    const combobox = html.match(/<button[^>]*role="combobox"[^>]*>/)?.[0] ?? "";
    expect(combobox).toContain('aria-label="Icône Calendar Clock"');
    expect(picker(["lucide"])).toContain('aria-label="Icône Choisir une icône"');
  });

  it("names the emoji trigger by the current emoji", () => {
    const html = picker(["emoji"], { icon: "emoji:🚜", color: null });
    expect(html).toContain('<span class="text-base leading-none">🚜</span>');
  });

  it("offers to choose an emoji while none is set", () => {
    expect(picker(["emoji"])).toContain("Choisir un emoji");
  });

  it("says the colour is not drawn under an image, and only then", () => {
    const note = "pas sous une image";
    expect(picker(["image"], { icon: "data:image/webp;base64,AAAA", color: "amber" })).toContain(
      note,
    );
    expect(picker(["lucide"], { icon: "lucide:bot", color: "amber" })).not.toContain(note);
    expect(picker(["emoji"], { icon: "emoji:🚜", color: null })).not.toContain(note);
    expect(picker(["image"])).not.toContain(note);
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
