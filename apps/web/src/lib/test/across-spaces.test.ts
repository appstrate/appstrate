// SPDX-License-Identifier: Apache-2.0

/** What lists spanning spaces share: the link into another space, its entry, the poll. */

import { describe, expect, it } from "bun:test";
import {
  ACROSS_SPACES_POLL_MS,
  linkedSpacePath,
  linkedSpaceStep,
  pollWhileMoving,
} from "../across-spaces.ts";

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

  it("enters an enterable space other than the current one", () => {
    expect(linkedSpaceStep("spc_2", "spc_1", true)).toBe("enter");
    // A new tab, before the resolver: entering sets the remembered space it will keep.
    expect(linkedSpaceStep("spc_2", null, true)).toBe("enter");
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

describe("pollWhileMoving", () => {
  const moving = (row: { live: boolean }) => row.live;

  it("polls while a row still moves", () => {
    expect(pollWhileMoving([{ live: false }, { live: true }], moving)).toBe(ACROSS_SPACES_POLL_MS);
  });

  it("does not poll once nothing moves, nor before an answer", () => {
    expect(pollWhileMoving([{ live: false }], moving)).toBe(false);
    expect(pollWhileMoving(undefined, moving)).toBe(false);
  });
});
