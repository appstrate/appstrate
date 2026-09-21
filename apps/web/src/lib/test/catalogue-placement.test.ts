// SPDX-License-Identifier: Apache-2.0

/**
 * The catalogue's reading of the placement model — the rule the whole screen
 * hangs on, pinned here because the wire and the interface use different words
 * for the same state (`none` is what an OFFER looks like on the wire).
 */

import { describe, it, expect } from "bun:test";
import { cataloguePlacement, inPlacedTab, pendingOfferCount } from "../catalogue-placement.ts";
import type { LibraryPackageItem } from "../../hooks/use-library.ts";

function pkg(
  placements: Array<{ space_id: string; state: "active" | "inactive" | "none"; via?: string }>,
  home: string | null = "spc_home",
): LibraryPackageItem {
  return {
    id: "@org/thing",
    type: "agent",
    source: "local",
    name: "Thing",
    description: "",
    home_space_id: home,
    home_writable: true,
    home_deletable: true,
    home_shareable: true,
    placements: placements.map((p) => ({
      space_id: p.space_id,
      via: (p.via ?? "shared") as "home" | "shared" | "system",
      state: p.state,
      shared_by: null,
    })),
  } as LibraryPackageItem;
}

describe("cataloguePlacement", () => {
  it("names the three states apart, and calls `none` an offer", () => {
    const placement = cataloguePlacement(
      pkg([
        { space_id: "spc_home", state: "active", via: "home" },
        { space_id: "spc_b", state: "inactive" },
        { space_id: "spc_c", state: "none" },
      ]),
      "spc_c",
    );
    expect(placement.here).toBe("offered");
    expect(placement.activeIn).toEqual(["spc_home"]);
    expect(placement.inactiveIn).toEqual(["spc_b"]);
    expect(placement.offeredIn).toEqual(["spc_c"]);
  });

  it("answers null for a space the package does not reach, without calling it unplaced", () => {
    const placement = cataloguePlacement(pkg([{ space_id: "spc_home", state: "active" }]), "spc_z");
    expect(placement.here).toBeNull();
    expect(placement.unplaced).toBe(false);
  });

  it("calls a package with no placement unplaced — the second tab's subject", () => {
    const placement = cataloguePlacement(pkg([], null), "spc_a");
    expect(placement.unplaced).toBe(true);
    expect(inPlacedTab(placement)).toBe(false);
  });

  it("keeps a system package in the placed tab although it is placed nowhere", () => {
    // A system agent, skill or MCP server is readable in every space without a
    // row: "not placed" would send it to Découvrir, where it cannot be added.
    const placement = cataloguePlacement(pkg([], null), "spc_a", { everywhere: true });
    expect(placement.unplaced).toBe(true);
    expect(inPlacedTab(placement)).toBe(true);
  });
});

describe("pendingOfferCount", () => {
  it("counts placements, not packages: one offer per space is one decision", () => {
    expect(
      pendingOfferCount([
        pkg([
          { space_id: "spc_a", state: "none" },
          { space_id: "spc_b", state: "none" },
          { space_id: "spc_home", state: "active", via: "home" },
        ]),
        pkg([{ space_id: "spc_c", state: "inactive" }]),
      ]),
    ).toBe(2);
  });

  it("is zero with nothing offered", () => {
    expect(pendingOfferCount([pkg([{ space_id: "spc_a", state: "active" }])])).toBe(0);
  });
});
