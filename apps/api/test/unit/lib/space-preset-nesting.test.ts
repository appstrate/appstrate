// SPDX-License-Identifier: Apache-2.0

/**
 * `SPACE_ROLE_PRESETS` is ordered strongest first and `assertPresetsUpwardClosed`
 * relies on it, so the order is checked against the preset → permission matrix,
 * where "stronger" means "grants a superset".
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

      // And strictly weaker, or the order says something the grants do not.
      expect(weakerGrants.size, `"${weaker}" grants as much as "${stronger}"`).toBeLessThan(
        strongerGrants.size,
      );
    }
  });
});
