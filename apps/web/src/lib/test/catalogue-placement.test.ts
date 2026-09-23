// SPDX-License-Identifier: Apache-2.0

/**
 * The catalogue's reading of the placement model — the rule the whole screen
 * hangs on, pinned here because the wire and the interface use different words
 * for the same state (`none` is what an OFFER looks like on the wire).
 */

import { describe, it, expect } from "bun:test";
import {
  cataloguePlacement,
  inPlacedTab,
  pendingOfferCount,
  pendingShares,
} from "../catalogue-placement.ts";
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
  };
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

  it("keeps a system package in the placed tab: the wire says it is active there", () => {
    // A system package has a placement in every space and, with no row of its
    // own, the server answers `active` — so it is placed, like any other row,
    // and its switch is the sticky opt-out.
    const placement = cataloguePlacement(
      pkg([{ space_id: "spc_a", via: "system", state: "active" }], null),
      "spc_a",
    );
    expect(placement.unplaced).toBe(false);
    expect(inPlacedTab(placement)).toBe(true);
  });

  it("sends a system package switched off in every space to Découvrir", () => {
    // Every space opted out: nothing runs it, and the second tab is where one
    // switches it back on.
    const placement = cataloguePlacement(
      pkg([{ space_id: "spc_a", via: "system", state: "inactive" }], null),
      "spc_a",
    );
    expect(inPlacedTab(placement)).toBe(false);
  });
});

describe("what is an offer, and what is merely off", () => {
  it("does not call a system integration nobody switched on an offer", () => {
    // `none` on the wire is "no row here", whatever put it there. Reading it as
    // an offer counted one per Appstrate integration per space.
    const placement = cataloguePlacement(
      pkg([{ space_id: "spc_a", state: "none", via: "system" }], null),
      "spc_a",
    );
    expect(placement.here).toBe("inactive");
    expect(placement.offeredIn).toEqual([]);
  });

  it("does not call a package at home nobody enabled an offer either", () => {
    const placement = cataloguePlacement(
      pkg([{ space_id: "spc_home", state: "none", via: "home" }]),
      "spc_home",
    );
    expect(placement.here).toBe("inactive");
  });

  it("sends a system integration switched on nowhere to Découvrir", () => {
    const placement = cataloguePlacement(
      pkg(
        [
          { space_id: "spc_a", state: "none", via: "system" },
          { space_id: "spc_b", state: "none", via: "system" },
        ],
        null,
      ),
      "spc_a",
    );
    expect(inPlacedTab(placement)).toBe(false);
  });

  it("keeps it in Espaces once one space runs it", () => {
    const placement = cataloguePlacement(
      pkg(
        [
          { space_id: "spc_a", state: "active", via: "system" },
          { space_id: "spc_b", state: "none", via: "system" },
        ],
        null,
      ),
      "spc_b",
    );
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
        // Not offers: off for a reason nobody has to decide on.
        pkg([{ space_id: "spc_d", state: "none", via: "system" }], null),
        pkg([{ space_id: "spc_home", state: "none", via: "home" }]),
      ]),
    ).toBe(2);
  });

  it("is zero with nothing offered", () => {
    expect(pendingOfferCount([pkg([{ space_id: "spc_a", state: "active" }])])).toBe(0);
  });
});

describe("pendingShares", () => {
  it("lists one decision per space a package was shared with, across kinds", () => {
    const agent = pkg([
      { space_id: "spc_a", state: "none" },
      { space_id: "spc_b", state: "none" },
      { space_id: "spc_home", state: "active", via: "home" },
    ]);
    const skill = {
      ...pkg([{ space_id: "spc_c", state: "none" }]),
      id: "@org/skill",
      type: "skill" as const,
    };
    const shares = pendingShares([agent, skill]);
    expect(shares.map((share) => [share.pkg.id, share.spaceId])).toEqual([
      ["@org/thing", "spc_a"],
      ["@org/thing", "spc_b"],
      ["@org/skill", "spc_c"],
    ]);
  });

  it("leaves out what is already switched on, off, or not a share", () => {
    expect(
      pendingShares([
        pkg([
          { space_id: "spc_a", state: "active" },
          { space_id: "spc_b", state: "inactive" },
          { space_id: "spc_c", state: "none", via: "system" },
        ]),
      ]),
    ).toEqual([]);
  });
});
