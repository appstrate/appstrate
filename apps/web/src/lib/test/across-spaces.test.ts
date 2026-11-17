// SPDX-License-Identifier: Apache-2.0

/** What lists spanning spaces share: the link into another space, and its entry. */

import { describe, expect, it } from "bun:test";
import { linkedSpacePath, linkedSpaceStep } from "../across-spaces.ts";

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
