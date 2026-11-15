// SPDX-License-Identifier: Apache-2.0

/**
 * The « Espace » scope of the lists spanning spaces: offered from two admitting spaces held with
 * a role; untouched it is the current space; the URL's `spaceId` wins (stale ids dropped, the
 * current space alone meaning none); without it, a remembered "all spaces" spans every one.
 */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage();

const { spaceSelection, storedSpaceIds } = await import("../use-space-filter.ts");

const space = (id: string, overrides: { access?: string; permissions?: string[] } = {}) => ({
  id,
  access: overrides.access ?? "member",
  permissions: overrides.permissions ?? ["runs:read", "schedules:read", "files:read"],
});

const ids = (spaces: { id: string }[]) => spaces.map((s) => s.id);
const readsSchedules = (permissions: readonly string[]) => permissions.includes("schedules:read");
const HERE = "spc_a";
const TWO = [space(HERE), space("spc_b")];

describe("spaceSelection", () => {
  it("offers nothing to a reader of one admitting space, whatever the URL or the memory says", () => {
    expect(spaceSelection([space(HERE)], "spc_a", readsSchedules, HERE, true)).toEqual({
      offered: [],
      selected: [],
    });
    expect(spaceSelection([space(HERE)], null, readsSchedules, HERE, true)).toEqual({
      offered: [],
      selected: [],
    });
  });

  it("leaves out a space listed without a role, or where the list is not admitted", () => {
    const spaces = [
      space(HERE),
      space("spc_closed", { access: "none" }),
      space("spc_blind", { permissions: ["runs:read"] }),
    ];
    expect(spaceSelection(spaces, null, readsSchedules, HERE, false).offered).toEqual([]);
    const withSecond = [...spaces, space("spc_b")];
    expect(ids(spaceSelection(withSecond, null, readsSchedules, HERE, false).offered)).toEqual([
      HERE,
      "spc_b",
    ]);
  });

  it("spans nothing untouched: the list stays on the current space's route", () => {
    expect(spaceSelection(TWO, null, readsSchedules, HERE, false).selected).toEqual([]);
  });

  it("spans every offered space when the reader keeps « all spaces » and the URL says nothing", () => {
    expect(ids(spaceSelection(TWO, null, readsSchedules, HERE, true).selected)).toEqual([
      HERE,
      "spc_b",
    ]);
  });

  it("lets an explicit param win over the memory", () => {
    expect(ids(spaceSelection(TWO, "spc_b", readsSchedules, HERE, true).selected)).toEqual([
      "spc_b",
    ]);
    // The current space alone is the space's own route, memory or not.
    expect(spaceSelection(TWO, "spc_a", readsSchedules, HERE, true).selected).toEqual([]);
  });

  it("drops an id the reader no longer reaches, keeping the listing's order", () => {
    const { selected } = spaceSelection(
      [space(HERE), space("spc_b"), space("spc_closed", { access: "none" })],
      "spc_b,spc_gone,spc_closed,spc_a",
      readsSchedules,
      HERE,
      false,
    );
    expect(ids(selected)).toEqual([HERE, "spc_b"]);
  });
});

describe("storedSpaceIds", () => {
  const offered = [space(HERE), space("spc_b"), space("spc_c")];

  it("keeps a first tick as the current space plus the one ticked, in listing order", () => {
    expect(storedSpaceIds(["spc_c", HERE], offered, HERE)).toEqual([HERE, "spc_c"]);
  });

  it("clears the param when the selection comes down to the current space, or to nothing", () => {
    expect(storedSpaceIds([HERE], offered, HERE)).toEqual([]);
    expect(storedSpaceIds([], offered, HERE)).toEqual([]);
  });

  it("keeps another space alone, and every space at once", () => {
    expect(storedSpaceIds(["spc_b"], offered, HERE)).toEqual(["spc_b"]);
    expect(storedSpaceIds(["spc_c", "spc_b", HERE], offered, HERE)).toEqual([
      HERE,
      "spc_b",
      "spc_c",
    ]);
  });
});
