// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { hiddenSpaceIds, inSpaces, resolveSpaceFilter, withAllSpaces } from "../space-filter.ts";

const team = { id: "spc_team", personal: false };
const team2 = { id: "spc_team2", personal: false };
const mine = { id: "spc_me", personal: true };

describe("resolveSpaceFilter", () => {
  it("narrows to the team spaces when the parameter is absent", () => {
    expect(resolveSpaceFilter(null, [team, mine, team2])).toEqual({
      offered: true,
      all: false,
      spaceIds: ["spc_team", "spc_team2"],
    });
  });

  it("does not narrow on `all`", () => {
    expect(resolveSpaceFilter("all", [team, mine])).toEqual({
      offered: true,
      all: true,
      spaceIds: undefined,
    });
  });

  it("treats any other value as absent: a URL is user input", () => {
    expect(resolveSpaceFilter("everything", [team, mine]).spaceIds).toEqual(["spc_team"]);
    expect(resolveSpaceFilter("", [team, mine]).spaceIds).toEqual(["spc_team"]);
  });

  it("offers nothing without a team space", () => {
    const state = resolveSpaceFilter(null, [mine]);
    expect(state.offered).toBe(false);
    expect(state.spaceIds).toBeUndefined();
  });

  it("offers nothing without a personal space", () => {
    const state = resolveSpaceFilter(null, [team, team2]);
    expect(state.offered).toBe(false);
    expect(state.spaceIds).toBeUndefined();
  });

  it("offers nothing when no space admits the list", () => {
    expect(resolveSpaceFilter(null, [])).toEqual({
      offered: false,
      all: false,
      spaceIds: undefined,
    });
  });
});

describe("inSpaces", () => {
  it("keeps every row when not narrowing", () => {
    expect(inSpaces(["spc_me"], undefined)).toBe(true);
    expect(inSpaces(undefined, undefined)).toBe(true);
  });

  it("keeps a row of a listed space and drops a personal-only one", () => {
    expect(inSpaces(["spc_team"], ["spc_team"])).toBe(true);
    expect(inSpaces(["spc_me"], ["spc_team"])).toBe(false);
  });

  it("keeps a row present in a personal AND a team space", () => {
    expect(inSpaces(["spc_me", "spc_team"], ["spc_team"])).toBe(true);
  });

  it("drops a row with no space when narrowing", () => {
    expect(inSpaces(undefined, ["spc_team"])).toBe(false);
    expect(inSpaces([], ["spc_team"])).toBe(false);
  });
});

describe("hiddenSpaceIds", () => {
  it("is the admitting spaces the filter drops", () => {
    expect(hiddenSpaceIds([team, mine, team2], ["spc_team", "spc_team2"])).toEqual(["spc_me"]);
  });

  it("is empty when nothing narrows", () => {
    expect(hiddenSpaceIds([team, mine], undefined)).toEqual([]);
  });
});

describe("withAllSpaces", () => {
  it("leaves the link alone when not spanning", () => {
    expect(withAllSpaces("/runs", false)).toBe("/runs");
  });

  it("adds the parameter when spanning", () => {
    expect(withAllSpaces("/runs", true)).toBe("/runs?space=all");
  });
});
