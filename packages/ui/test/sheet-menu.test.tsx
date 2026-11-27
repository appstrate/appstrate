// SPDX-License-Identifier: Apache-2.0

/** A menu as a phone shows it: rows a thumb can hit, a switch row that toggles as a whole, its hint behind an ⓘ, a red delete. */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SHEET_ROW_CLASS, SheetMenuSwitchRow } from "../src/components/sheet-menu.tsx";

describe("a sheet menu's rows", () => {
  it("are 48 px tall, left-aligned, and inset from the panel's edges", () => {
    const tokens = SHEET_ROW_CLASS.split(/\s+/);
    expect(tokens).toContain("min-h-12");
    expect(tokens).toContain("justify-start");
    // Inset like a dropdown's items, so a hover reads as the row, not a band across the panel.
    expect(tokens).toContain("mx-2");
    expect(tokens).toContain("rounded-lg");
    expect(tokens).toContain("desktop-pointer:mx-1");
    expect(tokens).toContain("desktop-pointer:rounded-md");
    expect(tokens).not.toContain("w-full");
  });

  it("inset the switch row the same way", () => {
    const out = renderToStaticMarkup(
      <SheetMenuSwitchRow id="s0" label="Limit" checked={false} onCheckedChange={() => {}} />,
    );
    expect(out).toContain("mx-2");
    expect(out).toContain("rounded-lg");
  });

  it("make a setting a label that toggles its switch, its hint behind an ⓘ beside the label", () => {
    const out = renderToStaticMarkup(
      <SheetMenuSwitchRow
        id="s1"
        label="Creation mode"
        hint="Off: no package is created."
        checked
        onCheckedChange={() => {}}
        testId="creation"
      />,
    );
    expect(out).toContain('<label for="s1"');
    expect(out).toContain('role="switch"');
    expect(out).toContain('aria-checked="true"');
    // Named by the label's text alone, not the ⓘ button's; described by the hint.
    expect(out).toContain('aria-labelledby="s1-label"');
    expect(out).toContain('aria-describedby="s1-hint"');
    expect(out).toContain('<span id="s1-hint" hidden="">Off: no package is created.</span>');
    expect(out).toContain('data-testid="creation-info"');
    expect(out).toContain('aria-label="More information"');
    // The bubble is not drawn until it is opened: the hint is in the hidden copy only.
    expect(out.split("Off: no package is created.")).toHaveLength(2);
  });

  it("draw no ⓘ and no description without a hint", () => {
    const out = renderToStaticMarkup(
      <SheetMenuSwitchRow id="s2" label="Limit" checked={false} onCheckedChange={() => {}} />,
    );
    expect(out).not.toContain("aria-describedby");
    expect(out).not.toContain("More information");
  });
});
