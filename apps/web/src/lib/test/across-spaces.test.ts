// SPDX-License-Identifier: Apache-2.0

/** What lists spanning spaces share: the link into another space, and its entry. */

import { describe, expect, it } from "bun:test";
import { linkedSpacePath, linkedSpaceStep, onePerPackage } from "../across-spaces.ts";

describe("linkedSpacePath", () => {
  it("leaves a link within the current space as it was", () => {
    expect(linkedSpacePath("/schedules/sch_1", "spc_1", "spc_1")).toBe("/schedules/sch_1");
  });

  it("names the space of a row of another space", () => {
    expect(linkedSpacePath("/schedules/sch_1", "spc_2", "spc_1")).toBe(
      "/schedules/sch_1?enterSpace=spc_2",
    );
  });

  it("has nothing to move from before a space is resolved", () => {
    expect(linkedSpacePath("/schedules/sch_1", "spc_2", null)).toBe("/schedules/sch_1");
  });
});

describe("linkedSpaceStep", () => {
  it("does nothing without a linked space", () => {
    expect(linkedSpaceStep(null, "spc_1", false)).toBe("none");
  });

  it("waits while the resolver enters an enterable space other than the current one", () => {
    expect(linkedSpaceStep("spc_2", "spc_1", true)).toBe("wait");
    // A cold load, before the resolver has scoped at all.
    expect(linkedSpaceStep("spc_2", null, true)).toBe("wait");
  });

  it("drops the param once in it, or when it cannot be entered", () => {
    expect(linkedSpaceStep("spc_2", "spc_2", true)).toBe("drop");
    expect(linkedSpaceStep("spc_gone", "spc_1", false)).toBe("drop");
  });

  it("waits for the space listing, and drops the param when it fails", () => {
    expect(linkedSpaceStep("spc_2", "spc_1", undefined)).toBe("wait");
    // The hook answers `false` for a listing that errored: the page renders its own state.
    expect(linkedSpaceStep("spc_2", "spc_1", false)).toBe("drop");
  });
});

describe("onePerPackage", () => {
  const row = (id: string, spaceId: string, running = 0) => ({
    id,
    spaceId,
    running,
    name: spaceId,
  });

  it("holds a package of several spaces once, its spaces in the reader's order", () => {
    const rows = [row("@acme/a", "spc_2"), row("@acme/a", "spc_1"), row("@acme/b", "spc_2")];
    expect(onePerPackage(rows, ["spc_1", "spc_2"])).toEqual([
      { ...row("@acme/a", "spc_1"), spaceIds: ["spc_1", "spc_2"] },
      { ...row("@acme/b", "spc_2"), spaceIds: ["spc_2"] },
    ]);
  });

  it("adds up the counters named, and keeps the first space's other fields", () => {
    const rows = [row("@acme/a", "spc_2", 2), row("@acme/a", "spc_1", 1)];
    expect(onePerPackage(rows, ["spc_1", "spc_2"], ["running"])).toEqual([
      { id: "@acme/a", spaceId: "spc_1", name: "spc_1", running: 3, spaceIds: ["spc_1", "spc_2"] },
    ]);
  });

  it("puts the home first when the reader reaches it, then the reader's order", () => {
    const rows = [
      { ...row("@acme/a", "spc_1"), home_space_id: "spc_2" },
      { ...row("@acme/a", "spc_2"), home_space_id: "spc_2" },
      { ...row("@acme/a", "spc_3"), home_space_id: "spc_2" },
    ];
    const [listed] = onePerPackage(rows, ["spc_1", "spc_2", "spc_3"]);
    expect(listed!.spaceIds).toEqual(["spc_2", "spc_1", "spc_3"]);
    expect(listed!.spaceId).toBe("spc_2");
  });

  it("keeps the reader's order when the home is withheld or not listed", () => {
    const rows = [
      { ...row("@acme/a", "spc_2"), home_space_id: null },
      { ...row("@acme/a", "spc_1"), home_space_id: null },
    ];
    expect(onePerPackage(rows, ["spc_1", "spc_2"])[0]!.spaceIds).toEqual(["spc_1", "spc_2"]);
  });

  it("puts a space the listing does not hold last, in the order received", () => {
    const rows = [row("@acme/a", "spc_x"), row("@acme/a", "spc_1")];
    expect(onePerPackage(rows, ["spc_1"])[0]!.spaceIds).toEqual(["spc_1", "spc_x"]);
  });
});
