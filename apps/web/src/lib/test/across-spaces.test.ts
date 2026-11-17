// SPDX-License-Identifier: Apache-2.0

/** What lists spanning spaces share: the link into another space, and its entry. */

import { describe, expect, it } from "bun:test";
import {
  linkedSpaceEnterable,
  linkedSpacePath,
  linkedSpaceStep,
  rowSpace,
} from "../across-spaces.ts";

describe("rowSpace", () => {
  it("opens a row listed in the current space there", () => {
    expect(rowSpace(["spc_1", "spc_2"], "spc_2")).toBe("spc_2");
  });

  it("enters the first space of a row the current space does not list", () => {
    expect(rowSpace(["spc_1", "spc_2"], "spc_3")).toBe("spc_1");
    expect(rowSpace(["spc_1", "spc_2"], null)).toBe("spc_1");
    expect(rowSpace(undefined, "spc_1")).toBeUndefined();
  });
});

describe("linkedSpacePath", () => {
  it("leaves a link within the current space as it was", () => {
    expect(linkedSpacePath("/schedules/sch_1", "spc_1", "spc_1")).toBe("/schedules/sch_1");
  });

  it("names the space of a row of another space", () => {
    expect(linkedSpacePath("/schedules/sch_1", "spc_2", "spc_1")).toBe(
      "/schedules/sch_1?enterSpace=spc_2",
    );
  });

  it("merges into the query the link carries and keeps its hash last", () => {
    expect(
      linkedSpacePath("/agents/@a/x?agentSettings=connections#settings", "spc_2", "spc_1"),
    ).toBe("/agents/@a/x?agentSettings=connections&enterSpace=spc_2#settings");
    expect(linkedSpacePath("/agents/@a/x#runs", "spc_2", "spc_1")).toBe(
      "/agents/@a/x?enterSpace=spc_2#runs",
    );
    // A stale space the link already names is replaced, never doubled.
    expect(linkedSpacePath("/runs?enterSpace=spc_9", "spc_2", "spc_1")).toBe(
      "/runs?enterSpace=spc_2",
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

describe("entering the space a link names (`?enterSpace=B`)", () => {
  const listing = [
    { id: "spc_a", access: "member" },
    { id: "spc_b", access: "member" },
    { id: "spc_closed", access: "none" },
  ];
  /** The step `useEnterLinkedSpace` takes for `linked`, from `current`, given the listing. */
  const step = (
    linked: string,
    current: string | null,
    spaces: typeof listing | undefined,
    failed = false,
  ) => linkedSpaceStep(linked, current, linkedSpaceEnterable(spaces, failed, linked));

  it("keeps the param while the resolver enters B, drops it once current is B", () => {
    expect(step("spc_b", "spc_a", undefined)).toBe("wait");
    expect(step("spc_b", "spc_a", listing)).toBe("wait");
    expect(step("spc_b", "spc_b", listing)).toBe("drop");
  });

  it("drops it at once when B cannot be entered, or the listing failed", () => {
    expect(step("spc_closed", "spc_a", listing)).toBe("drop");
    expect(step("spc_gone", "spc_a", listing)).toBe("drop");
    expect(step("spc_b", "spc_a", undefined, true)).toBe("drop");
  });
});
