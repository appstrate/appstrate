// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  inSpaces,
  nextSpaceParam,
  resolveSpaceFilter,
  showsTeamEmpty,
  withAllSpaces,
  withSpaceChoice,
} from "../space-filter.ts";

const team = { id: "spc_team", personal: false };
const team2 = { id: "spc_team2", personal: false };
const mine = { id: "spc_me", personal: true };

describe("resolveSpaceFilter", () => {
  it("defaults to the team preset when the parameter is absent", () => {
    expect(resolveSpaceFilter(null, [team, mine, team2])).toEqual({
      offered: true,
      preset: true,
      mode: "team",
      spaceIds: ["spc_team", "spc_team2"],
      runs: { spaceKind: "team" },
    });
  });

  it("does not narrow on `all`", () => {
    expect(resolveSpaceFilter("all", [team, mine])).toEqual({
      offered: true,
      preset: true,
      mode: "all",
      spaceIds: undefined,
      runs: {},
    });
  });

  it("narrows to exactly the picked spaces, the run list by id", () => {
    expect(resolveSpaceFilter("spc_me,spc_team2", [team, mine, team2])).toEqual({
      offered: true,
      preset: true,
      mode: "custom",
      spaceIds: ["spc_me", "spc_team2"],
      runs: { spaceIds: ["spc_me", "spc_team2"] },
    });
  });

  it("drops ids of spaces that do not admit the list, and repeated ones", () => {
    const state = resolveSpaceFilter("spc_gone,spc_me,spc_me,garbage", [team, mine]);
    expect(state.mode).toBe("custom");
    expect(state.spaceIds).toEqual(["spc_me"]);
  });

  it("reads a pick left empty, or any garbage, as absent: a URL is user input", () => {
    for (const raw of ["spc_gone", "everything", "", ","]) {
      const state = resolveSpaceFilter(raw, [team, mine]);
      expect(state.mode, raw).toBe("team");
      expect(state.spaceIds, raw).toEqual(["spc_team"]);
    }
  });

  it("has no preset without a personal space: every space is the default", () => {
    const state = resolveSpaceFilter(null, [team, team2]);
    expect(state).toEqual({
      offered: true,
      preset: false,
      mode: "all",
      spaceIds: undefined,
      runs: {},
    });
    expect(resolveSpaceFilter("spc_team2", [team, team2]).mode).toBe("custom");
  });

  it("has no preset without a team space", () => {
    const state = resolveSpaceFilter(null, [mine, { id: "spc_me2", personal: true }]);
    expect(state.offered).toBe(true);
    expect(state.preset).toBe(false);
    expect(state.mode).toBe("all");
  });

  it("offers nothing with fewer than two spaces", () => {
    expect(resolveSpaceFilter(null, [mine])).toMatchObject({ offered: false, mode: "all" });
    expect(resolveSpaceFilter("spc_me", [mine])).toMatchObject({
      offered: false,
      mode: "all",
      spaceIds: undefined,
    });
    expect(resolveSpaceFilter(null, [])).toMatchObject({ offered: false, spaceIds: undefined });
  });
});

describe("nextSpaceParam", () => {
  it("ticking the preset goes back to team: the parameter is removed", () => {
    // From all (nothing ticked) and from a pick (the preset joins the picked ids).
    expect(nextSpaceParam(["team"], true)).toBeNull();
    expect(nextSpaceParam(["spc_a", "team"], true)).toBeNull();
  });

  it("unticking the preset widens to every space", () => {
    expect(nextSpaceParam([], true)).toBe("all");
  });

  it("ticking spaces from all picks them", () => {
    expect(nextSpaceParam(["spc_a"], true)).toBe("spc_a");
    expect(nextSpaceParam(["spc_a", "spc_b"], true)).toBe("spc_a,spc_b");
  });

  it("unticking down to nothing goes back to every space", () => {
    expect(nextSpaceParam([], true)).toBe("all");
    // Without the preset, every space is the default: no parameter.
    expect(nextSpaceParam([], false)).toBeNull();
    expect(nextSpaceParam(["spc_a"], false)).toBe("spc_a");
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

describe("showsTeamEmpty", () => {
  const base = { readerFiltered: false, hiddenCount: 3 };

  it("speaks when the team preset hides something and the reader filtered nothing", () => {
    expect(showsTeamEmpty(base)).toBe(true);
  });

  it("stays quiet when nothing exists elsewhere: the page's own empty state wins", () => {
    expect(showsTeamEmpty({ ...base, hiddenCount: 0 })).toBe(false);
  });

  it("stays quiet when the reader filtered", () => {
    expect(showsTeamEmpty({ ...base, readerFiltered: true })).toBe(false);
  });
});

describe("withSpaceChoice", () => {
  it("writes the value, keeping the other parameters", () => {
    const next = withSpaceChoice(new URLSearchParams("status=failed&q=x"), "spc_a,spc_b");
    expect(next.get("space")).toBe("spc_a,spc_b");
    expect(next.get("status")).toBe("failed");
    expect(next.get("q")).toBe("x");
  });

  it("removes the parameter on null, keeping the other parameters", () => {
    const next = withSpaceChoice(new URLSearchParams("space=all&kind=inline"), null);
    expect(next.has("space")).toBe(false);
    expect(next.get("kind")).toBe("inline");
  });

  it("does not mutate the URL it was given", () => {
    const prev = new URLSearchParams("a=1");
    withSpaceChoice(prev, "all");
    expect(prev.has("space")).toBe(false);
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
