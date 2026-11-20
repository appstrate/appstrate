// SPDX-License-Identifier: Apache-2.0

/** A menu as a phone shows it: rows a thumb can hit, a switch row that toggles as a whole, a red delete. */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SHEET_ROW_CLASS, SheetMenuRow, SheetMenuSwitchRow } from "../src/ui/sheet-menu.tsx";

describe("a sheet menu's rows", () => {
  it("are 48 px tall, left-aligned, and as wide as the panel", () => {
    const tokens = SHEET_ROW_CLASS.split(/\s+/);
    expect(tokens).toContain("min-h-12");
    expect(tokens).toContain("w-full");
    expect(tokens).toContain("justify-start");
  });

  it("show the destructive one in red", () => {
    const out = renderToStaticMarkup(<SheetMenuRow destructive>Delete</SheetMenuRow>);
    expect(out).toContain("text-destructive");
    expect(renderToStaticMarkup(<SheetMenuRow>Rename</SheetMenuRow>)).not.toContain(
      "text-destructive",
    );
  });

  it("make a setting a label that toggles its switch, with its hint under it", () => {
    const out = renderToStaticMarkup(
      <SheetMenuSwitchRow
        id="s1"
        label="Creation mode"
        hint="Off: no package is created."
        checked
        onCheckedChange={() => {}}
      />,
    );
    expect(out).toContain('<label for="s1"');
    expect(out).toContain('role="switch"');
    expect(out).toContain('aria-checked="true"');
    expect(out).toContain("Off: no package is created.");
  });
});
