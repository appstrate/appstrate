// SPDX-License-Identifier: Apache-2.0

/**
 * The « Espace » scope of the lists spanning spaces. On a page: offered from two admitting
 * spaces held with a role, untouched it is the current space, the URL's `spaceId` widens it
 * (stale ids dropped, the current space alone meaning none). In the overview: every admitting
 * space by default, the URL narrowing it.
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

describe("spaceSelection on a page", () => {
  it("offers nothing to a reader of one admitting space, whatever the URL says", () => {
    expect(spaceSelection([space(HERE)], "spc_a", readsSchedules, HERE, "current")).toEqual({
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
    expect(spaceSelection(spaces, null, readsSchedules, HERE, "current").offered).toEqual([]);
    const withSecond = [...spaces, space("spc_b")];
    expect(ids(spaceSelection(withSecond, null, readsSchedules, HERE, "current").offered)).toEqual([
      HERE,
      "spc_b",
    ]);
  });

  it("spans nothing untouched: the list stays on the current space's route", () => {
    expect(spaceSelection(TWO, null, readsSchedules, HERE, "current").selected).toEqual([]);
  });

  it("spans what the URL names, the current space alone being its own route", () => {
    expect(ids(spaceSelection(TWO, "spc_b", readsSchedules, HERE, "current").selected)).toEqual([
      "spc_b",
    ]);
    expect(spaceSelection(TWO, "spc_a", readsSchedules, HERE, "current").selected).toEqual([]);
  });

  it("drops an id the reader no longer reaches, keeping the listing's order", () => {
    const { selected } = spaceSelection(
      [space(HERE), space("spc_b"), space("spc_closed", { access: "none" })],
      "spc_b,spc_gone,spc_closed,spc_a",
      readsSchedules,
      HERE,
      "current",
    );
    expect(ids(selected)).toEqual([HERE, "spc_b"]);
  });
});

describe("spaceSelection in the overview", () => {
  it("spans every admitting space by default, a single one included", () => {
    expect(ids(spaceSelection(TWO, null, readsSchedules, HERE, "all").selected)).toEqual([
      HERE,
      "spc_b",
    ]);
    expect(ids(spaceSelection([space(HERE)], null, readsSchedules, HERE, "all").selected)).toEqual([
      HERE,
    ]);
  });

  it("narrows to what the URL names, the current space alone included", () => {
    expect(ids(spaceSelection(TWO, "spc_a", readsSchedules, HERE, "all").selected)).toEqual([HERE]);
  });

  it("falls back to every space when the URL names none it reaches", () => {
    expect(ids(spaceSelection(TWO, "spc_gone", readsSchedules, HERE, "all").selected)).toEqual([
      HERE,
      "spc_b",
    ]);
  });
});

describe("storedSpaceIds", () => {
  const offered = [space(HERE), space("spc_b"), space("spc_c")];

  it("keeps a first tick on a page as the current space plus the one ticked, in listing order", () => {
    expect(storedSpaceIds(["spc_c", HERE], offered, HERE, "current")).toEqual([HERE, "spc_c"]);
  });

  it("clears the param on a page when the selection comes down to the current space, or to nothing", () => {
    expect(storedSpaceIds([HERE], offered, HERE, "current")).toEqual([]);
    expect(storedSpaceIds([], offered, HERE, "current")).toEqual([]);
  });

  it("keeps every space on a page: widening is carried by the URL alone", () => {
    expect(storedSpaceIds(["spc_c", "spc_b", HERE], offered, HERE, "current")).toEqual([
      HERE,
      "spc_b",
      "spc_c",
    ]);
  });

  it("clears the param in the overview when every space is chosen, keeps a narrowing", () => {
    expect(storedSpaceIds(["spc_c", "spc_b", HERE], offered, HERE, "all")).toEqual([]);
    expect(storedSpaceIds([HERE], offered, HERE, "all")).toEqual([HERE]);
  });
});
