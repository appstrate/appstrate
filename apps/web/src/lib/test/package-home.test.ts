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

const { homeNameBesideTiles, previousHomeSchedules, writableDestinations } =
  await import("../package-home.ts");

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

describe("homeNameBesideTiles", () => {
  const home = { homeSpaceId: "spc_b", homeSpaceName: "Studio" };

  it("says the home only where no tile names it", () => {
    expect(homeNameBesideTiles({ ...home, spaceIds: ["spc_b", "spc_a"] })).toBeNull();
    expect(homeNameBesideTiles({ ...home, spaceIds: ["spc_a"] })).toBe("Studio");
    expect(homeNameBesideTiles({ ...home, spaceIds: [] })).toBe("Studio");
  });

  it("says nothing while the tiles are read, so the line does not jump", () => {
    expect(homeNameBesideTiles({ ...home, spaceIds: undefined })).toBeNull();
  });
});

describe("previousHomeSchedules", () => {
  const ok = { readable: true, isError: false };
  const rows = [
    { spaceId: "spc_old", enabled: true },
    { spaceId: "spc_old", enabled: true },
    { spaceId: "spc_old", enabled: false },
    { spaceId: "spc_other", enabled: true },
  ];

  it("counts only the enabled rows of the old home", () => {
    expect(previousHomeSchedules(rows, "spc_old", ok)).toBe(2);
  });

  it("is 0 when the old home has none", () => {
    expect(previousHomeSchedules(rows, "spc_none", ok)).toBe(0);
  });

  it("keeps the count unknown while the list is read", () => {
    expect(previousHomeSchedules(undefined, "spc_old", ok)).toBe("unknown");
  });

  it("is unknown when not readable or on error, even with data", () => {
    expect(previousHomeSchedules(rows, "spc_old", { readable: false, isError: false })).toBe(
      "unknown",
    );
    expect(previousHomeSchedules(rows, "spc_old", { readable: true, isError: true })).toBe(
      "unknown",
    );
    expect(previousHomeSchedules(undefined, "spc_old", { readable: false, isError: false })).toBe(
      "unknown",
    );
  });
});
