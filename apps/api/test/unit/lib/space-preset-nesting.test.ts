// SPDX-License-Identifier: Apache-2.0

/**
 * `SPACE_ROLE_PRESETS` is ordered strongest first, and the module loader reads
 * it in that order to decide whether a module's `presets` list is upward-closed
 * (`assertPresetsUpwardClosed`). Nothing in the type system says so: the tuple
 * is four strings, and reordering it would silently change which module
 * contributions boot — a `builder`-only grant would start passing, handing a
 * space admin less than a builder.
 *
 * The loader used to hold a private copy of the ordering, which made the
 * question undecidable in both places at once. This is the answer instead: the
 * order is checked against the thing that actually defines it, the preset →
 * permission matrix, where "stronger" means "grants a superset".
 */

import { describe, expect, it } from "bun:test";
import { SPACE_ROLE_PRESETS } from "@appstrate/core/permissions";
import { presetPermissions } from "../../../src/lib/permissions.ts";

describe("SPACE_ROLE_PRESETS ordering", () => {
  it("lists the presets strongest first, per the preset → permission matrix", () => {
    // Positive control: an empty or single-entry tuple would pass vacuously.
    expect(SPACE_ROLE_PRESETS.length).toBeGreaterThan(1);

    for (let i = 0; i + 1 < SPACE_ROLE_PRESETS.length; i++) {
      const stronger = SPACE_ROLE_PRESETS[i]!;
      const weaker = SPACE_ROLE_PRESETS[i + 1]!;
      const strongerGrants = presetPermissions(stronger);
      const weakerGrants = presetPermissions(weaker);

      const missing = [...weakerGrants].filter((p) => !strongerGrants.has(p)).sort();
      expect(
        missing,
        `Preset "${weaker}" is listed after "${stronger}" in SPACE_ROLE_PRESETS, so it must ` +
          `grant a SUBSET of it. It holds permissions "${stronger}" does not:\n  ` +
          missing.join("\n  "),
      ).toEqual([]);

      // And strictly weaker, or the two are interchangeable and the order says
      // something the grants do not.
      expect(weakerGrants.size, `"${weaker}" grants as much as "${stronger}"`).toBeLessThan(
        strongerGrants.size,
      );
    }
  });
});
