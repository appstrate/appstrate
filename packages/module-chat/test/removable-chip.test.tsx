// SPDX-License-Identifier: Apache-2.0

/** A composer chip reads at 14 px on a phone and keeps the dense size from `md`. */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RemovableChip } from "../src/ui/removable-chip.tsx";

describe("a removable chip", () => {
  it("is 14 px on a phone and dense from md", () => {
    const out = renderToStaticMarkup(
      <RemovableChip icon={<i />} removeLabel="Remove" onRemove={() => {}}>
        Limited to Sales
      </RemovableChip>,
    );
    const classes = /class="([^"]*text-sm[^"]*)"/.exec(out)?.[1].split(/\s+/) ?? [];
    expect(classes).toContain("text-sm");
    expect(classes).toContain("md:text-xs");
    expect(classes).not.toContain("text-xs");
  });
});
