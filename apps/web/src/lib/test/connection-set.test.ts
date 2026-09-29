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
  displayedConnectionIds,
  checkedConnectionIds,
  placeCreatedConnection,
  unavailableConnectionIds,
  withConnectionOverride,
  withConnectionPick,
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
  const a = { id: "conn_a" };
  const b = { id: "conn_b" };
  const candidateIds = ["conn_a", "conn_b"];
  const conns = (ids: string[]) => [a, b].filter((c) => ids.includes(c.id));

  it("refuses the empty set and the stored pick, in any order", () => {
    // Control: a touched set that differs from the stored pick is writable.
    expect(canApplyConnectionSet([a, b], [], true)).toBe(true);
    expect(canApplyConnectionSet([], [], true)).toBe(false);
    expect(canApplyConnectionSet([b, a], ["conn_a", "conn_b"], true)).toBe(false);
  });

  it("refuses an untouched menu ticked from the cascade's resolved default", () => {
    // Writing it would pin {a, b} and detach the member from later org-default
    // changes. Control: the same ticks after an actual edit are writable.
    const input = { explicitIds: [], resolvedIds: candidateIds, candidateIds };
    const untouched = checkedConnectionIds({ ...input, draft: null });
    expect(untouched).toEqual(candidateIds);
    expect(canApplyConnectionSet(conns(untouched), [], false)).toBe(false);
    expect(canApplyConnectionSet(conns(untouched), [], true)).toBe(true);
  });

  it("refuses an untouched override that inherits — it would freeze the cascade", () => {
    const explicitIds: string[] = [];
    expect(
      displayedConnectionIds({ overrideMode: true, explicitIds, resolvedIds: ["conn_a"] }),
    ).toEqual([]);
    const untouched = checkedConnectionIds({
      draft: null,
      explicitIds,
      resolvedIds: ["conn_a"],
      candidateIds,
    });
    expect(canApplyConnectionSet(conns(untouched), explicitIds, false)).toBe(false);
  });

  it("lets the actor rewrite a stored pick that names an unavailable connection", () => {
    // Nothing was ticked or unticked, yet the stored set differs from what a
    // write would send: without this the ghost id could never be dropped.
    const explicitIds = ["conn_a", "conn_unshared"];
    const cleaned = checkedConnectionIds({
      draft: null,
      explicitIds,
      resolvedIds: [],
      candidateIds,
    });
    expect(cleaned).toEqual(["conn_a"]);
    expect(canApplyConnectionSet(conns(cleaned), explicitIds, false)).toBe(true);
    // Control: an untouched pick with no ghost has nothing to rewrite.
    expect(canApplyConnectionSet([a], ["conn_a"], false)).toBe(false);
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

describe("placeCreatedConnection", () => {
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
      placeCreatedConnection({
        explicitIds: [],
        checkedIds: shown,
        createdId: "conn_new",
        max: 10,
      }),
    ).toEqual({ persist: ["conn_new"] });
  });

  it("only ticks it beside an explicit pick: a pin never grows into a set unasked", () => {
    expect(
      placeCreatedConnection({
        explicitIds: ["conn_mine"],
        checkedIds: ["conn_mine"],
        createdId: "conn_new",
        max: 10,
      }),
    ).toEqual({ draft: ["conn_mine", "conn_new"] });
  });

  it("ticks onto the unsaved ticks, not the stored pick", () => {
    expect(
      placeCreatedConnection({
        explicitIds: ["conn_mine"],
        checkedIds: ["conn_other"],
        createdId: "conn_new",
        max: 10,
      }),
    ).toEqual({ draft: ["conn_other", "conn_new"] });
  });

  it("leaves the ticks as they are at the cap", () => {
    expect(
      placeCreatedConnection({
        explicitIds: ["conn_mine"],
        checkedIds: ["conn_mine"],
        createdId: "conn_new",
        max: 1,
      }),
    ).toEqual({ draft: ["conn_mine"] });
  });
});

describe("unavailableConnectionIds", () => {
  it("names the stored members the actor can no longer reach, in stored order", () => {
    expect(unavailableConnectionIds(["gone-2", "a", "gone-1"], ["a", "b"])).toEqual([
      "gone-2",
      "gone-1",
    ]);
  });

  it("is empty while every stored member is a candidate, and with nothing stored", () => {
    expect(unavailableConnectionIds(["a", "b"], ["a", "b", "c"])).toEqual([]);
    expect(unavailableConnectionIds([], ["a"])).toEqual([]);
  });

  // The scenario the picker exists for: [a, gone] stored, `gone` deleted by its
  // owner. Untouched, the ticks are the survivors and "Valider" is live — it
  // writes [a], the change the unavailable row announces.
  it("leaves 'Valider' live on the survivors, and dead once nothing survives", () => {
    const explicitIds = ["a", "gone"];
    const candidateIds = ["a", "b"];
    const checked = checkedConnectionIds({
      draft: null,
      explicitIds,
      resolvedIds: [],
      candidateIds,
    });
    expect(checked).toEqual(["a"]);
    expect(canApplyConnectionSet([{ id: "a" }], explicitIds, false)).toBe(true);
    expect(
      checkedConnectionIds({ draft: null, explicitIds: ["gone"], resolvedIds: [], candidateIds }),
    ).toEqual([]);
    expect(canApplyConnectionSet([], ["gone"], false)).toBe(false);
  });
});

describe("withConnectionPick", () => {
  it("replaces one integration's set and leaves the others", () => {
    const picks = { "@acme/a": ["1"], "@acme/b": ["2"] };
    expect(withConnectionPick(picks, "@acme/a", ["3", "4"])).toEqual({
      "@acme/a": ["3", "4"],
      "@acme/b": ["2"],
    });
    expect(picks["@acme/a"]).toEqual(["1"]);
  });

  it("drops the key for an empty set — the wire refuses one", () => {
    expect(withConnectionPick({ "@acme/a": ["1"] }, "@acme/a", [])).toEqual({});
  });
});

describe("withConnectionOverride", () => {
  it("drops `connection_overrides` once its last pick is cleared", () => {
    const overrides = { model_id_override: "m", connection_overrides: { "@acme/a": ["1"] } };
    expect(withConnectionOverride(overrides, "@acme/a", [])).toEqual({ model_id_override: "m" });
    expect(withConnectionOverride({}, "@acme/a", ["1"])).toEqual({
      connection_overrides: { "@acme/a": ["1"] },
    });
  });
});
