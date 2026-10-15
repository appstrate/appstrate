// SPDX-License-Identifier: Apache-2.0

/**
 * The catalogue's reading of the placement model — the rule the whole screen
 * hangs on, pinned here because the wire and the interface use different words
 * for the same state (`none` is what an OFFER looks like on the wire).
 */

import { describe, it, expect } from "bun:test";
import {
  cataloguePlacement,
  detailSpace,
  pendingShares,
  placementIn,
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
    published: true,
    activation: [],
    placements: placements.map((p) => ({
      space_id: p.space_id,
      via: (p.via ?? "shared") as "home" | "shared" | "system",
      state: p.state,
      chat_enforced: false,
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

  it("answers null for a space the package does not reach", () => {
    const placement = cataloguePlacement(pkg([{ space_id: "spc_home", state: "active" }]), "spc_z");
    expect(placement.here).toBeNull();
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
});

describe("placementIn", () => {
  it("reads the state of each space the package is placed in, and null elsewhere", () => {
    const placement = cataloguePlacement(
      pkg([
        { space_id: "spc_home", state: "active", via: "home" },
        { space_id: "spc_a", state: "none" },
        { space_id: "spc_b", state: "inactive" },
      ]),
      "spc_home",
    );
    expect(placementIn(placement, "spc_home")).toBe("active");
    expect(placementIn(placement, "spc_a")).toBe("offered");
    expect(placementIn(placement, "spc_b")).toBe("inactive");
    expect(placementIn(placement, "spc_c")).toBeNull();
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
        pkg([{ space_id: "spc_home", state: "none", via: "home" }]),
      ]),
    ).toEqual([]);
  });
});

describe("detailSpace", () => {
  const spaces = [{ id: "spc_here" }, { id: "spc_home" }, { id: "spc_b" }];

  it("reads an agent not placed in the current space from its home, not from the current space", () => {
    // The space the reader stands in cannot read it: the detail answers only
    // where the package is placed.
    const placement = cataloguePlacement(
      pkg([{ space_id: "spc_home", state: "active", via: "home" }]),
      "spc_here",
    );
    expect(detailSpace(placement, spaces, "spc_here")).toBe("spc_home");
  });

  it("CONTROL: reads a package placed here from here", () => {
    const placement = cataloguePlacement(
      pkg([
        { space_id: "spc_home", state: "active", via: "home" },
        { space_id: "spc_here", state: "none" },
      ]),
      "spc_here",
    );
    expect(detailSpace(placement, spaces, "spc_here")).toBe("spc_here");
  });

  it("falls back to a space that holds it when the home is out of reach", () => {
    const placement = cataloguePlacement(
      pkg([{ space_id: "spc_b", state: "inactive" }], "spc_hidden"),
      "spc_here",
    );
    expect(detailSpace(placement, spaces, "spc_here")).toBe("spc_b");
  });
});
