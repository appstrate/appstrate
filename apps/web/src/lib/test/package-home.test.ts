// SPDX-License-Identifier: Apache-2.0

/**
 * `writableDestinations` — which spaces the package "move" dialog may offer
 * (RBAC spec §6.9). The WRITE verdict is not computed in the SPA at all:
 * `home_writable` arrives on the package's own read, from `homeWireForCaller`
 * server-side, and the API integration suites pin it.
 */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
});

const { writableDestinations } = await import("../package-home.ts");

type Space = { id: string; name: string; permissions: string[] };

const space = (id: string, permissions: string[]): Space => ({ id, name: id, permissions });

describe("writableDestinations", () => {
  const spaces = [
    space("spc_home", ["skills:write"]),
    space("spc_other", ["skills:write"]),
    space("spc_reader", ["skills:read"]),
    space("spc_unjoined", []),
  ];

  it("offers the spaces where the caller may author this type, minus the current home", () => {
    expect(writableDestinations(spaces, "skill", "spc_home").map((s) => s.id)).toEqual([
      "spc_other",
    ]);
  });

  it("asks for the type's own permission, not any write", () => {
    // `agents:write` is a different resource: the same four spaces offer nothing.
    expect(writableDestinations(spaces, "agent", "spc_home")).toEqual([]);
  });

  it("offers every writable space when the home is null (catalog, or withheld)", () => {
    expect(writableDestinations(spaces, "skill", null).map((s) => s.id)).toEqual([
      "spc_home",
      "spc_other",
    ]);
  });

  it("never offers a PERSONAL space, however writable it is", () => {
    // Its owner holds the `admin` preset there, so the permission test passes
    // and the API refuses the move all the same (409
    // `home_move_into_personal_space`, RBAC spec §6.9): a personal space homes
    // only what is created or forked in it. The team space beside it carries
    // the very same permission and stays on the list, so what is excluded is
    // the personal FLAG, not a missing grant.
    const mixedSpaces = [
      { ...space("spc_mine", ["skills:write"]), personal: true },
      { ...space("spc_team", ["skills:write"]), personal: false },
    ];

    expect(writableDestinations(mixedSpaces, "skill", "spc_home").map((s) => s.id)).toEqual([
      "spc_team",
    ]);
  });

  it("offers nothing while the space list is loading", () => {
    expect(writableDestinations(undefined, "skill", "spc_home")).toEqual([]);
  });
});
