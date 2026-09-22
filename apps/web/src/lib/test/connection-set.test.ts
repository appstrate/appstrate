// SPDX-License-Identifier: Apache-2.0

/**
 * Set composition shared by every connection-composing surface: the write cap,
 * the pin-vs-override asymmetry of "no explicit pick", and which ids may reach
 * a `connection_ids` body.
 */

import { describe, it, expect } from "bun:test";
import {
  toggleCapped,
  keepAvailable,
  canApplyConnectionSet,
  sharedLabels,
  displayedConnectionIds,
  checkedConnectionIds,
  joinCreatedConnection,
} from "../connection-set";

describe("toggleCapped", () => {
  it("adds an absent id", () => {
    expect(toggleCapped(["a"], "b", 10)).toEqual(["a", "b"]);
  });

  it("removes a present id — even at the cap", () => {
    const full = ["a", "b"];
    expect(toggleCapped(full, "a", 2)).toEqual(["b"]);
  });

  it("refuses to grow past the cap", () => {
    // Control: the same call one below the cap does add.
    const full = ["a", "b"];
    expect(toggleCapped(full, "c", 2)).toBe(full);
    expect(toggleCapped(["a"], "c", 2)).toEqual(["a", "c"]);
  });
});

describe("keepAvailable", () => {
  it("drops an id that is no longer available, keeping order", () => {
    expect(keepAvailable(["b", "gone", "a"], ["a", "b"])).toEqual(["b", "a"]);
  });
});

describe("canApplyConnectionSet", () => {
  const a = { id: "conn_a", label: "work" };
  const b = { id: "conn_b", label: "perso" };

  it("refuses a set whose labels collide — the server would 400 it", () => {
    // Control: the same two ids with distinct labels are writable.
    expect(canApplyConnectionSet([a, b], [])).toBe(true);
    expect(canApplyConnectionSet([a, { ...b, label: "work" }], [])).toBe(false);
  });

  it("refuses the empty set and the stored pick, in any order", () => {
    expect(canApplyConnectionSet([], [])).toBe(false);
    expect(canApplyConnectionSet([b, a], ["conn_a", "conn_b"])).toBe(false);
  });

  it("lets the actor rewrite a stored pick that names an unavailable connection", () => {
    // Nothing was ticked or unticked, yet the stored set differs from what a
    // write would send: without this the ghost id could never be dropped.
    expect(canApplyConnectionSet([a], ["conn_a", "conn_unshared"])).toBe(true);
  });
});

describe("sharedLabels", () => {
  it("names each repeated label once, and nothing for distinct labels", () => {
    const rows = [{ label: "web" }, { label: "db" }, { label: "web" }, { label: "web" }];
    expect(sharedLabels(rows)).toEqual(["web"]);
    expect(sharedLabels([{ label: "web" }, { label: "db" }])).toEqual([]);
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
});

describe("checkedConnectionIds", () => {
  const candidateIds = ["conn_a", "conn_b"];

  it("never ticks a pinned id that is no longer a candidate", () => {
    // Kept, it would read "Valider (2)" over one visible tick, could not be
    // unticked, and would send a PUT the server refuses.
    expect(
      checkedConnectionIds({
        draft: null,
        explicitIds: ["conn_a", "conn_unshared"],
        resolvedIds: [],
        candidateIds,
      }),
    ).toEqual(["conn_a"]);
  });

  it("prefers the draft, then the explicit pick, then the cascade", () => {
    const base = { explicitIds: ["conn_a"], resolvedIds: ["conn_b"], candidateIds };
    expect(checkedConnectionIds({ ...base, draft: ["conn_b"] })).toEqual(["conn_b"]);
    expect(checkedConnectionIds({ ...base, draft: null })).toEqual(["conn_a"]);
    expect(checkedConnectionIds({ ...base, draft: null, explicitIds: [] })).toEqual(["conn_b"]);
  });
});

describe("joinCreatedConnection", () => {
  const candidateIds = ["conn_org_default", "conn_mine"];

  it("binds only the created connection when the actor had no pick of their own", () => {
    // Control: the picker DISPLAYS the org default as bound here. Joining onto
    // that displayed set would write ["conn_org_default", "conn_new"] as a
    // member pin and silently detach the member from later org-default changes.
    const shown = displayedConnectionIds({
      overrideMode: false,
      explicitIds: [],
      resolvedIds: ["conn_org_default"],
    });
    expect(shown).toEqual(["conn_org_default"]);
    expect(
      joinCreatedConnection({ explicitIds: [], candidateIds, createdId: "conn_new", max: 10 }),
    ).toEqual(["conn_new"]);
  });

  it("joins the actor's own pick instead of replacing it", () => {
    expect(
      joinCreatedConnection({
        explicitIds: ["conn_mine"],
        candidateIds,
        createdId: "conn_new",
        max: 10,
      }),
    ).toEqual(["conn_mine", "conn_new"]);
  });

  it("drops an unavailable id from the base rather than resending it", () => {
    expect(
      joinCreatedConnection({
        explicitIds: ["conn_mine", "conn_unshared"],
        candidateIds,
        createdId: "conn_new",
        max: 10,
      }),
    ).toEqual(["conn_mine", "conn_new"]);
  });

  it("writes nothing when the cap is reached or the id is already bound", () => {
    expect(
      joinCreatedConnection({ explicitIds: ["conn_mine"], candidateIds, createdId: "x", max: 1 }),
    ).toBeNull();
    expect(
      joinCreatedConnection({
        explicitIds: ["conn_mine"],
        candidateIds,
        createdId: "conn_mine",
        max: 10,
      }),
    ).toBeNull();
  });
});
