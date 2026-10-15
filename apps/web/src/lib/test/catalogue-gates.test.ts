// SPDX-License-Identifier: Apache-2.0

/**
 * The catalogue's verdicts: an activation switch reads the server's verdict on the library row
 * (`activation`, judged by `getPackageLibrary` as the routes judge it), and words each refusal by
 * the half that is missing. The deeds read the row's home verdicts.
 */

import { describe, expect, it } from "bun:test";
import { activationGate, catalogueDeeds } from "../catalogue-gates.ts";
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
    placement("spc_guest", "shared", "none"),
  ];

  it("offers the share and each withdrawal to a reader with the home's authority", () => {
    expect(
      catalogueDeeds(
        packageRow("agent", placements, { home_space_id: "spc_home", home_shareable: true }),
      ),
    ).toEqual({ share: true, revokeFrom: ["spc_guest"] });
  });

  it("offers neither to a reader without the home's authority", () => {
    // CONTROL for the case above, on the same placements. Writing does not grant sharing.
    expect(
      catalogueDeeds(
        packageRow("agent", placements, { home_space_id: "spc_home", home_writable: true }),
      ),
    ).toEqual({ share: false, revokeFrom: [] });
  });
});
