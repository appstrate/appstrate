// SPDX-License-Identifier: Apache-2.0

/**
 * The « Espace » scope of the lists spanning spaces. Out of « Vue d'ensemble »: offered from two admitting
 * spaces held with a role, untouched it is the current space, the URL's `spaceId` widens it
 * (stale ids dropped, the current space alone meaning none). In « Vue d'ensemble »: every
 * admitting space by default, the URL narrowing it.
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

describe("spaceSelection out of the mode", () => {
  it("offers nothing to a reader of one admitting space, whatever the URL says", () => {
    expect(spaceSelection([space(HERE)], "spc_a", readsSchedules, HERE, false)).toEqual({
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

  it("spans what the URL names, the current space alone being its own route", () => {
    expect(ids(spaceSelection(TWO, "spc_b", readsSchedules, HERE, false).selected)).toEqual([
      "spc_b",
    ]);
    expect(spaceSelection(TWO, "spc_a", readsSchedules, HERE, false).selected).toEqual([]);
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

describe("spaceSelection in « Vue d'ensemble »", () => {
  it("spans every admitting space by default, a single one included", () => {
    expect(ids(spaceSelection(TWO, null, readsSchedules, HERE, true).selected)).toEqual([
      HERE,
      "spc_b",
    ]);
    expect(ids(spaceSelection([space(HERE)], null, readsSchedules, HERE, true).selected)).toEqual([
      HERE,
    ]);
  });

  it("narrows to what the URL names, the current space alone included", () => {
    expect(ids(spaceSelection(TWO, "spc_a", readsSchedules, HERE, true).selected)).toEqual([HERE]);
  });

  it("falls back to every space when the URL names none it reaches", () => {
    expect(ids(spaceSelection(TWO, "spc_gone", readsSchedules, HERE, true).selected)).toEqual([
      HERE,
      "spc_b",
    ]);
  });
});

describe("storedSpaceIds", () => {
  const offered = [space(HERE), space("spc_b"), space("spc_c")];

  it("keeps a first tick out of the mode as the current space plus the one ticked, in listing order", () => {
    expect(storedSpaceIds(["spc_c", HERE], offered, HERE, false)).toEqual([HERE, "spc_c"]);
  });

  it("clears the param out of the mode when the selection comes down to the current space, or to nothing", () => {
    expect(storedSpaceIds([HERE], offered, HERE, false)).toEqual([]);
    expect(storedSpaceIds([], offered, HERE, false)).toEqual([]);
  });

  it("keeps every space out of the mode: widening is carried by the URL alone", () => {
    expect(storedSpaceIds(["spc_c", "spc_b", HERE], offered, HERE, false)).toEqual([
      HERE,
      "spc_b",
      "spc_c",
    ]);
  });

  it("clears the param in the mode when every space is chosen, keeps a narrowing", () => {
    expect(storedSpaceIds(["spc_c", "spc_b", HERE], offered, HERE, true)).toEqual([]);
    expect(storedSpaceIds([HERE], offered, HERE, true)).toEqual([HERE]);
  });
});
