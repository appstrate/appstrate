// SPDX-License-Identifier: Apache-2.0

/**
 * Set semantics shared by every connection-composing surface: the write cap,
 * and the pin-vs-override asymmetry of "no explicit pick".
 */

import { describe, it, expect } from "bun:test";
import { toggleCapped, displayedConnectionIds, EMPTY_CONNECTION_SET } from "../connection-set";

describe("toggleCapped", () => {
  it("adds an absent id", () => {
    expect(toggleCapped(["a"], "b", 10)).toEqual(["a", "b"]);
  });

  it("removes a present id — even at the cap", () => {
    const full = ["a", "b"];
    expect(toggleCapped(full, "a", 2)).toEqual(["b"]);
  });

  it("refuses to grow past the cap, and says so by identity", () => {
    // Control: the same call one below the cap does add.
    const full = ["a", "b"];
    expect(toggleCapped(full, "c", 2)).toBe(full);
    expect(toggleCapped(["a"], "c", 2)).toEqual(["a", "c"]);
  });

  it("never duplicates an id already in the set", () => {
    expect(toggleCapped(["a"], "a", 10)).toEqual([]);
  });
});

describe("displayedConnectionIds", () => {
  const resolvedIds = ["conn_resolved"];

  it("shows the explicit pick in both modes", () => {
    const explicitIds = ["conn_picked"];
    expect(displayedConnectionIds({ overrideMode: false, explicitIds, resolvedIds })).toEqual([
      "conn_picked",
    ]);
    expect(displayedConnectionIds({ overrideMode: true, explicitIds, resolvedIds })).toEqual([
      "conn_picked",
    ]);
  });

  it("falls back to the cascade in pin mode, but NOT in override mode", () => {
    // Same inputs, only the mode differs: pin mode has no "inherit" state, so
    // an unpinned agent page still displays the connection a run would use;
    // an override with no pick IS inherit and must display nothing.
    const explicitIds: string[] = [];
    expect(displayedConnectionIds({ overrideMode: false, explicitIds, resolvedIds })).toEqual(
      resolvedIds,
    );
    expect(displayedConnectionIds({ overrideMode: true, explicitIds, resolvedIds })).toEqual([]);
  });

  it("returns the stable empty set for an inheriting override", () => {
    // Identity matters: this value feeds a controlled prop, and a fresh []
    // per render would re-fork the picker's draft state every render.
    expect(displayedConnectionIds({ overrideMode: true, explicitIds: [], resolvedIds })).toBe(
      EMPTY_CONNECTION_SET,
    );
  });
});
