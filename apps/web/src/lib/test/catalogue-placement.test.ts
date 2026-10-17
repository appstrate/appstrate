// SPDX-License-Identifier: Apache-2.0

/**
 * The catalogue's reading of the placement model — the rule the whole screen
 * hangs on, pinned here because the wire and the interface use different words
 * for the same state (`none` is "no row", read like `inactive`).
 */

import { describe, it, expect } from "bun:test";
import {
  cataloguePlacement,
  detailSpace,
  inPlacedTab,
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
  it("names the two states apart, and reads `none` like `inactive`", () => {
    const placement = cataloguePlacement(
      pkg([
        { space_id: "spc_home", state: "active", via: "home" },
        { space_id: "spc_b", state: "inactive" },
        { space_id: "spc_c", state: "none" },
      ]),
      "spc_c",
    );
    expect(placement.here).toBe("inactive");
    expect(placement.activeIn).toEqual(["spc_home"]);
    expect(placement.inactiveIn).toEqual(["spc_b", "spc_c"]);
  });

  it("keeps who shared a placement that is switched off, and only that", () => {
    const row = pkg([
      { space_id: "spc_home", state: "active", via: "home" },
      { space_id: "spc_on", state: "active" },
      { space_id: "spc_off", state: "inactive" },
      { space_id: "spc_sys", state: "inactive", via: "system" },
    ]);
    const named = {
      ...row,
      placements: row.placements.map((p) =>
        p.space_id === "spc_off" ? { ...p, shared_by: { user_id: "u1", name: "Bob" } } : p,
      ),
    };
    expect(cataloguePlacement(named, "spc_off").sharedBy).toEqual({ spc_off: "Bob" });
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

describe("what is merely off", () => {
  it("reads a system integration nobody switched on as inactive, not shared", () => {
    // `none` on the wire is "no row here", whatever put it there.
    const placement = cataloguePlacement(
      pkg([{ space_id: "spc_a", state: "none", via: "system" }], null),
      "spc_a",
    );
    expect(placement.here).toBe("inactive");
    expect(placement.sharedBy).toEqual({});
  });

  it("reads a package at home nobody enabled as inactive", () => {
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
    expect(placementIn(placement, "spc_a")).toBe("inactive");
    expect(placementIn(placement, "spc_b")).toBe("inactive");
    expect(placementIn(placement, "spc_c")).toBeNull();
  });
});

describe("detailSpace", () => {
  const spaces = [{ id: "spc_here" }, { id: "spc_home" }, { id: "spc_b" }];

  it("reads an agent not placed in the current space from its home, not from the current space", () => {
    // The space the reader stands in cannot read it: the detail answers only
    // where the package is placed, and a failed read would skip the
    // activation's integration question.
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
