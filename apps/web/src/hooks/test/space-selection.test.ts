// SPDX-License-Identifier: Apache-2.0

/**
 * The « Espace » filter of the lists spanning spaces: offered from two admitting spaces held
 * with a role; untouched it is the current space and filters nothing; a tick adds to it; a
 * selection that comes down to the current space alone is the default route again; and an id
 * the reader no longer reaches is never sent (the org route answers 400 on it).
 */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage();

const { urlListParams } = await import("../../lib/list-params.ts");
const { spaceSelection, storedSpaceIds } = await import("../use-space-filter.ts");

const space = (id: string, overrides: { access?: string; permissions?: string[] } = {}) => ({
  id,
  access: overrides.access ?? "member",
  permissions: overrides.permissions ?? ["runs:read", "schedules:read", "files:read"],
});

const urlList = (search: string) => urlListParams(new URLSearchParams(search), () => {}, []);
const ids = (spaces: { id: string }[]) => spaces.map((s) => s.id);
const readsSchedules = (permissions: readonly string[]) => permissions.includes("schedules:read");
const HERE = "spc_a";

describe("spaceSelection", () => {
  it("offers nothing to a reader of one admitting space, whatever the URL says", () => {
    const result = spaceSelection([space(HERE)], urlList("spaceId=spc_a"), readsSchedules, HERE);
    expect(result).toEqual({ offered: [], selected: [] });
  });

  it("leaves out a space listed without a role, or where the list is not admitted", () => {
    const spaces = [
      space(HERE),
      space("spc_closed", { access: "none" }),
      space("spc_blind", { permissions: ["runs:read"] }),
    ];
    expect(spaceSelection(spaces, urlList(""), readsSchedules, HERE).offered).toEqual([]);
    const withSecond = [...spaces, space("spc_b")];
    expect(ids(spaceSelection(withSecond, urlList(""), readsSchedules, HERE).offered)).toEqual([
      HERE,
      "spc_b",
    ]);
  });

  it("selects nothing untouched: the list stays on the current space's route", () => {
    expect(
      spaceSelection([space(HERE), space("spc_b")], urlList(""), readsSchedules, HERE).selected,
    ).toEqual([]);
  });

  it("never sends the current space alone to the org route", () => {
    const { selected } = spaceSelection(
      [space(HERE), space("spc_b")],
      urlList("spaceId=spc_a"),
      readsSchedules,
      HERE,
    );
    expect(selected).toEqual([]);
  });

  it("drops an id the reader no longer reaches, keeping the listing's order", () => {
    const { selected } = spaceSelection(
      [space(HERE), space("spc_b"), space("spc_closed", { access: "none" })],
      urlList("spaceId=spc_b,spc_gone,spc_closed,spc_a"),
      readsSchedules,
      HERE,
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
