// SPDX-License-Identifier: Apache-2.0

/**
 * The preset lattice: which preset grants a superset of which. It is what
 * `assertPresetsUpwardClosed` reads through `presetsStrictlyStrongerThan`, and
 * it is NOT the order of `SPACE_ROLE_PRESETS` — that tuple is the order a
 * picker renders. `runner` and `viewer` are incomparable, so the presets are a
 * lattice and not a chain; the edges are asserted by hand here so that adding
 * or removing one is a deliberate diff.
 */

import { describe, expect, it } from "bun:test";
import { SPACE_ROLE_PRESETS } from "@appstrate/core/permissions";
import type { SpaceRolePreset } from "@appstrate/core/permissions";
import { presetPermissions, presetsStrictlyStrongerThan } from "../../../src/lib/permissions.ts";

/** Every containment that holds: `[narrower, wider]`, wider granting strictly more. */
const NESTED_PAIRS: readonly (readonly [SpaceRolePreset, SpaceRolePreset])[] = [
  ["builder", "admin"],
  ["operator", "builder"],
  ["viewer", "operator"],
  ["runner", "operator"],
];

/** Pairs that are incomparable — each holds something the other does not. */
const INCOMPARABLE_PAIRS: readonly (readonly [SpaceRolePreset, SpaceRolePreset])[] = [
  ["runner", "viewer"],
];

describe("the space-preset lattice", () => {
  it("nests every pair the matrix claims to nest", () => {
    for (const [narrow, wide] of NESTED_PAIRS) {
      const narrowGrants = presetPermissions(narrow);
      const wideGrants = presetPermissions(wide);
      const missing = [...narrowGrants].filter((p) => !wideGrants.has(p)).sort();
      expect(
        missing,
        `Preset "${wide}" must grant a SUPERSET of "${narrow}". It is missing:\n  ` +
          missing.join("\n  "),
      ).toEqual([]);
      expect(wideGrants.size, `"${wide}" grants no more than "${narrow}"`).toBeGreaterThan(
        narrowGrants.size,
      );
    }
  });

  it("keeps `runner` and `viewer` incomparable, in both directions", () => {
    // The whole point of the preset: a runner launches what it cannot read, a
    // viewer reads what it cannot launch. Asserted in both directions so that
    // quietly widening either one shows up here.
    for (const [a, b] of INCOMPARABLE_PAIRS) {
      const aGrants = presetPermissions(a);
      const bGrants = presetPermissions(b);
      expect([...aGrants].filter((p) => !bGrants.has(p)).sort()).not.toEqual([]);
      expect([...bGrants].filter((p) => !aGrants.has(p)).sort()).not.toEqual([]);
    }
    expect(presetPermissions("runner").has("agents:run")).toBe(true);
    expect(presetPermissions("viewer").has("agents:run")).toBe(false);
    expect(presetPermissions("runner").has("agents:read")).toBe(false);
    expect(presetPermissions("viewer").has("agents:read")).toBe(true);
  });

  it("derives `presetsStrictlyStrongerThan` from those edges, transitively", () => {
    // Positive control: an implementation returning [] everywhere would pass
    // nothing below.
    expect(presetsStrictlyStrongerThan("admin")).toEqual([]);
    expect(presetsStrictlyStrongerThan("builder")).toEqual(["admin"]);
    expect(presetsStrictlyStrongerThan("operator")).toEqual(["admin", "builder"]);
    // `viewer` is NOT above `runner`, which is what lets a module grant a read
    // resource to `viewer` alone (`assertPresetsUpwardClosed`).
    expect(presetsStrictlyStrongerThan("runner")).toEqual(["admin", "builder", "operator"]);
    expect(presetsStrictlyStrongerThan("viewer")).toEqual(["admin", "builder", "operator"]);
  });

  it("renders the presets widest-reach first, so no preset precedes one above it", () => {
    // The tuple is a display order, but it must not contradict the lattice: a
    // preset listed later never grants a superset of one listed earlier.
    expect(SPACE_ROLE_PRESETS.length).toBeGreaterThan(1);
    for (let i = 0; i < SPACE_ROLE_PRESETS.length; i++) {
      const earlier = SPACE_ROLE_PRESETS[i]!;
      for (const later of SPACE_ROLE_PRESETS.slice(i + 1)) {
        expect(
          presetsStrictlyStrongerThan(earlier),
          `"${later}" grants a superset of "${earlier}" but is listed after it`,
        ).not.toContain(later);
      }
    }
  });
});
