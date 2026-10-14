// SPDX-License-Identifier: Apache-2.0

/**
 * The catalogue's verdicts against the placement model they project. Every
 * switch answers two halves: is the package PLACED in the target space (if not,
 * switching it on shares it out of its home and asks for `home_shareable`), and
 * may this reader flip it THERE (the type's grant in that space, or owning it —
 * RBAC spec §3.6). Each refusal sits next to its CONTROL.
 */

import { describe, expect, it } from "bun:test";
import { activationGate, catalogueDeeds } from "../catalogue-gates.ts";
import type { SpaceGrant } from "../package-permissions.ts";
import type { LibraryPackageItem, LibraryPlacement } from "../../hooks/use-library.ts";

function grant(permissions: string[], overrides: Partial<SpaceGrant> = {}): SpaceGrant {
  return { permissions, personal: false, access: "member", ...overrides };
}

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
    ...overrides,
  };
}

const ALLOWED = { allowed: true, refusal: null };

describe("activationGate", () => {
  it("names a missing grant in the target space, by direction", () => {
    const pkg = packageRow("agent", [
      placement("spc_a", "home", "active"),
      placement("spc_b", "shared", "none"),
    ]);
    expect(activationGate(pkg, "spc_a", grant([]), false)).toEqual({
      allowed: false,
      refusal: "deactivate",
    });
    expect(activationGate(pkg, "spc_b", grant([]), true)).toEqual({
      allowed: false,
      refusal: "activate",
    });
  });

  it("CONTROL: uses each target space's own grant", () => {
    const pkg = packageRow("agent", [
      placement("spc_a", "shared", "inactive"),
      placement("spc_b", "shared", "inactive"),
    ]);
    expect(activationGate(pkg, "spc_a", grant([]), true).allowed).toBe(false);
    expect(activationGate(pkg, "spc_b", grant(["agents:configure"]), true)).toEqual(ALLOWED);
  });

  it("lets a reader holding the home's share grant place a package in a space it never reached", () => {
    const pkg = packageRow("agent", [placement("spc_home", "home", "active")], {
      home_space_id: "spc_home",
      home_shareable: true,
    });
    expect(activationGate(pkg, "spc_new", grant(["agents:configure"]), true)).toEqual(ALLOWED);
  });

  it("refuses that click without the home's share grant, and says which half is missing", () => {
    // CONTROL for the case above: same grant in the target space, no
    // `home_shareable` — refused, and not for the reason the grant would give.
    const pkg = packageRow("agent", [placement("spc_home", "home", "active")], {
      home_space_id: "spc_home",
    });
    expect(activationGate(pkg, "spc_new", grant(["agents:configure"]), true)).toEqual({
      allowed: false,
      refusal: "notPlaced",
    });
    expect(activationGate(pkg, "spc_home", grant(["agents:configure"]), false)).toEqual(ALLOWED);
  });

  it("asks an unplaced package for the home's share grant even from a personal space's owner", () => {
    const pkg = packageRow("agent", []);
    const mine = grant([], { personal: true });
    expect(activationGate(pkg, "spc_mine", mine, true)).toEqual({
      allowed: false,
      refusal: "notPlaced",
    });
    // CONTROL: once shareable, owning the space is the whole authorization.
    expect(activationGate({ ...pkg, home_shareable: true }, "spc_mine", mine, true)).toEqual(
      ALLOWED,
    );
  });

  it("reads activate and deactivate as separate grants for integrations", () => {
    const pkg = packageRow(
      "integration",
      [
        placement("spc_activator", "system", "active"),
        placement("spc_remover", "system", "active"),
        placement("spc_off", "system", "inactive"),
        placement("spc_new", "system", "inactive"),
      ],
      { source: "system" },
    );
    const install = grant(["integrations:install"]);
    const uninstall = grant(["integrations:uninstall"]);
    // Active, and the reader may only switch ON here.
    expect(activationGate(pkg, "spc_activator", install, false).refusal).toBe("deactivate");
    expect(activationGate(pkg, "spc_remover", uninstall, false)).toEqual(ALLOWED);
    // Off, and the reader may only switch OFF here.
    expect(activationGate(pkg, "spc_off", uninstall, true).refusal).toBe("activate");
    expect(activationGate(pkg, "spc_new", install, true)).toEqual(ALLOWED);
  });

  it("lets a system agent be switched off in a space, like any other package", () => {
    const pkg = packageRow("agent", [placement("spc_a", "system", "active")], { source: "system" });
    expect(activationGate(pkg, "spc_a", grant(["agents:configure"]), false)).toEqual(ALLOWED);
    // CONTROL: being system buys no exemption from the grant.
    expect(activationGate(pkg, "spc_a", grant([]), false).refusal).toBe("deactivate");
  });

  it("keeps writes disabled while permissions load, blaming nobody for it", () => {
    const pkg = packageRow("integration", [placement("spc_a", "shared", "inactive")]);
    expect(activationGate(pkg, "spc_a", undefined, true)).toEqual({
      allowed: false,
      refusal: null,
    });
    // CONTROL: the same switch once the grant is known.
    expect(activationGate(pkg, "spc_a", grant(["integrations:install"]), true)).toEqual(ALLOWED);
  });
});

describe("catalogueDeeds", () => {
  const placements = [
    placement("spc_home", "home", "active"),
    placement("spc_guest", "shared", "none"),
  ];

  it("offers the move, the share and each withdrawal to a reader with the home's authority", () => {
    expect(
      catalogueDeeds(
        packageRow("agent", placements, {
          home_space_id: "spc_home",
          home_writable: true,
          home_shareable: true,
        }),
      ),
    ).toEqual({ moveHome: true, share: true, revokeFrom: ["spc_guest"] });
  });

  it("offers neither the move nor the share to a reader without the home's authority", () => {
    // CONTROL for the case above, on the same placements.
    expect(catalogueDeeds(packageRow("agent", placements, { home_space_id: "spc_home" }))).toEqual({
      moveHome: false,
      share: false,
      revokeFrom: [],
    });
  });

  it("reads the two verbs apart: writing does not grant sharing", () => {
    expect(catalogueDeeds(packageRow("agent", placements, { home_writable: true }))).toEqual({
      moveHome: true,
      share: false,
      revokeFrom: [],
    });
  });
});
