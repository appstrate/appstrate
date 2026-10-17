// SPDX-License-Identifier: Apache-2.0

/**
 * The catalogue's verdicts: an activation switch reads the server's verdict on the library row
 * (`activation`, judged by `getPackageLibrary` as the routes judge it), and words each refusal by
 * the half that is missing. The deeds read the row's home verdicts.
 */

import { describe, expect, it } from "bun:test";
import { activationGate, catalogueDeeds, mayRemoveFromSpace } from "../catalogue-gates.ts";
import type { LibraryPackageItem, LibraryPlacement } from "../../hooks/use-library.ts";

function placement(
  space_id: string,
  via: LibraryPlacement["via"],
  state: LibraryPlacement["state"],
): LibraryPlacement {
  return { space_id, via, state, shared_by: null, chat_enforced: false };
}

function packageRow(
  type: LibraryPackageItem["type"],
  placements: LibraryPlacement[],
  overrides: Partial<LibraryPackageItem> = {},
): LibraryPackageItem {
  return {
    id: "@org/example",
    name: "Example",
    description: "",
    type,
    source: "local",
    home_space_id: null,
    home_writable: false,
    home_shareable: false,
    home_deletable: false,
    published: true,
    placements,
    activation: [],
    ...overrides,
  };
}

const ALLOWED = { allowed: true, refusal: null };

describe("activationGate", () => {
  const pkg = packageRow("agent", [placement("spc_a", "home", "active")], {
    activation: [
      { spaceId: "spc_a", activate: "allowed", deactivate: "forbidden" },
      { spaceId: "spc_b", activate: "not_shareable", deactivate: "not_shareable" },
    ],
  });

  it("reads the verdict of the direction asked, in the target space", () => {
    expect(activationGate(pkg, "spc_a", true)).toEqual(ALLOWED);
    expect(activationGate(pkg, "spc_a", false)).toEqual({ allowed: false, refusal: "deactivate" });
  });

  it("blames the home's share right when the package is not placed there", () => {
    expect(activationGate(pkg, "spc_b", true)).toEqual({ allowed: false, refusal: "notPlaced" });
  });

  it("words a missing grant by direction", () => {
    const off = packageRow("agent", [], {
      activation: [{ spaceId: "spc_c", activate: "forbidden", deactivate: "allowed" }],
    });
    expect(activationGate(off, "spc_c", true)).toEqual({ allowed: false, refusal: "activate" });
    expect(activationGate(off, "spc_c", false)).toEqual(ALLOWED);
  });

  it("refuses a space the row has no verdict for, blaming nobody", () => {
    expect(activationGate(pkg, "spc_unknown", true)).toEqual({ allowed: false, refusal: null });
  });
});

describe("catalogueDeeds", () => {
  const placements = [
    placement("spc_home", "home", "active"),
    placement("spc_guest", "shared", "inactive"),
  ];

  it("offers the move, the share and each withdrawal to a reader with the home's authority", () => {
    expect(
      catalogueDeeds(
        packageRow("agent", placements, {
          home_space_id: "spc_home",
          home_writable: true,
          home_shareable: true,
        }),
        "spc_home",
      ),
    ).toEqual({ moveHome: true, share: true, revokeFrom: ["spc_guest"] });
  });

  it("offers neither the move nor the share to a reader without the home's authority", () => {
    // CONTROL for the case above, on the same placements.
    expect(
      catalogueDeeds(packageRow("agent", placements, { home_space_id: "spc_home" }), "spc_home"),
    ).toEqual({ moveHome: false, share: false, revokeFrom: [] });
  });

  it("reads the two verbs apart: writing does not grant sharing", () => {
    expect(
      catalogueDeeds(packageRow("agent", placements, { home_writable: true }), "spc_home"),
    ).toEqual({ moveHome: true, share: false, revokeFrom: [] });
  });

  it("lets the recipient remove a placement from the space they stand in", () => {
    const row = packageRow("agent", placements, {
      activation: [{ spaceId: "spc_guest", activate: "allowed", deactivate: "allowed" }],
    });
    expect(catalogueDeeds(row, "spc_guest").revokeFrom).toEqual(["spc_guest"]);
  });

  it("does not list the current space twice for a sharer who is also its recipient", () => {
    const row = packageRow("agent", placements, {
      home_shareable: true,
      activation: [{ spaceId: "spc_guest", activate: "allowed", deactivate: "allowed" }],
    });
    expect(catalogueDeeds(row, "spc_guest").revokeFrom).toEqual(["spc_guest"]);
  });
});

describe("mayRemoveFromSpace", () => {
  const verdicts = (deactivate: "allowed" | "forbidden") => [
    { spaceId: "spc_home", activate: "allowed" as const, deactivate: "allowed" as const },
    { spaceId: "spc_guest", activate: "allowed" as const, deactivate },
  ];
  const placements = [
    placement("spc_home", "home", "active"),
    placement("spc_guest", "shared", "inactive"),
    placement("spc_sys", "system", "active"),
  ];

  it("is open where someone else placed the package and the caller may switch it off", () => {
    const row = packageRow("skill", placements, { activation: verdicts("allowed") });
    expect(mayRemoveFromSpace(row, "spc_guest")).toBe(true);
  });

  it("follows the switch's deactivation verdict: refused there, refused here", () => {
    const row = packageRow("skill", placements, { activation: verdicts("forbidden") });
    expect(mayRemoveFromSpace(row, "spc_guest")).toBe(false);
  });

  it("is closed at home, for a system package, and for a space the package is not in", () => {
    const row = packageRow("skill", placements, {
      activation: [
        ...verdicts("allowed"),
        { spaceId: "spc_sys", activate: "allowed", deactivate: "allowed" },
        { spaceId: "spc_none", activate: "allowed", deactivate: "allowed" },
      ],
    });
    expect(mayRemoveFromSpace(row, "spc_home")).toBe(false);
    expect(mayRemoveFromSpace(row, "spc_sys")).toBe(false);
    expect(mayRemoveFromSpace(row, "spc_none")).toBe(false);
    expect(mayRemoveFromSpace(row, null)).toBe(false);
  });
});
