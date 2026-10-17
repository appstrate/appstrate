// SPDX-License-Identifier: Apache-2.0

/**
 * Set composition shared by every connection-composing surface: the write cap,
 * "no pick" (`null`) versus "no connection" (`[]`), and which ids may reach a
 * `connection_ids` body.
 */

import { describe, it, expect } from "bun:test";
import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
import {
  toggleCapped,
  keepAvailable,
  connectionSetToSave,
  imposedThenAdded,
  placeCreatedConnection,
  shownConnectionPick,
  unavailableConnectionIds,
  withConnectionOverride,
  withDeclaredConnections,
} from "../connection-set";

describe("toggleCapped", () => {
  // A set one below the cap, and one at it.
  const belowCap = Array.from({ length: MAX_CONNECTIONS_PER_INTEGRATION - 1 }, (_, i) => `c${i}`);
  const full = [...belowCap, "last"];

  it("adds an absent id", () => {
    expect(toggleCapped(["a"], "b")).toEqual(["a", "b"]);
  });

  it("removes a present id — even at the cap", () => {
    expect(toggleCapped(full, "last")).toEqual(belowCap);
  });

  it("refuses to grow past the cap", () => {
    // Control: the same call one below the cap does add.
    expect(toggleCapped(full, "new")).toBe(full);
    expect(toggleCapped(belowCap, "new")).toEqual([...belowCap, "new"]);
  });

  it("caps at what an imposed set leaves", () => {
    expect(toggleCapped(["a"], "b", 1)).toEqual(["a"]);
    expect(toggleCapped(["a"], "a", 1)).toEqual([]);
    expect(toggleCapped([], "b", 0)).toEqual([]);
  });
});

describe("imposedThenAdded", () => {
  it("binds the imposed set whole, in its order, then the additions it lacks", () => {
    expect(imposedThenAdded(["t1", "t2"], ["p", "t1", "q"])).toEqual(["t1", "t2", "p", "q"]);
    expect(imposedThenAdded(["t1"], [])).toEqual(["t1"]);
    // An addition is never cut to fit: the server refuses the union over the cap.
    expect(imposedThenAdded(["t1"], ["t1"])).toEqual(["t1"]);
  });
});

describe("keepAvailable", () => {
  it("drops an id that is not available, keeping order", () => {
    expect(keepAvailable(["b", "gone", "a"], ["a", "b"])).toEqual(["b", "a"]);
  });
});

describe("connectionSetToSave", () => {
  const save = (
    ticked: string[],
    stored: string[] | null,
    initial: string[] = stored ?? [],
    emptyValue: string[] | null | undefined = undefined,
  ) => connectionSetToSave({ ticked, initial, stored, emptyValue });

  it("writes a changed set, never the stored one again, in any order", () => {
    expect(save(["a", "b"], ["a"])).toEqual(["a", "b"]);
    expect(save(["b", "a"], ["a", "b"])).toBeUndefined();
  });

  it("never writes [] — « Aucune connexion » is its own action — but replaces a stored one", () => {
    expect(save([], ["a"])).toBeUndefined();
    expect(save([], [])).toBeUndefined();
    expect(save(["a"], [])).toEqual(["a"]);
  });

  it("writes nothing while an unset choice is shown untouched: the default is not a choice", () => {
    // The ticks show what the cascade binds; writing them would pin the default and detach the
    // member from later changes.
    expect(save(["a"], null, ["a"])).toBeUndefined();
    // Control: ticks after an actual edit are writable, the cascade's own included.
    expect(save(["a", "b"], null, ["a"])).toEqual(["a", "b"]);
    expect(save(["b"], null, [])).toEqual(["b"]);
  });

  it("lets the actor rewrite a stored pick that names an unavailable connection", () => {
    // [a, gone] stored, `gone` deleted by its owner: untouched, the ticks are the survivors and
    // « Enregistrer » writes [a], the change the unavailable line announces.
    expect(save(["a"], ["a", "gone"], ["a"])).toEqual(["a"]);
    // Control: an untouched pick with no ghost has nothing to rewrite.
    expect(save(["a"], ["a"])).toBeUndefined();
    // No member survives: the set left to write is empty, which is no answer.
    expect(save([], ["gone"], [])).toBeUndefined();
  });

  it("writes « no addition » for an empty tick under an imposed set, as the caller encodes it", () => {
    // An override: `[]`; the member's pin: no pin (`null`).
    expect(save([], ["db"], ["db"], [])).toEqual([]);
    expect(save([], ["db"], ["db"], null)).toBeNull();
    // Already no addition: nothing to write.
    expect(save([], [], [], [])).toBeUndefined();
    expect(save([], null, [], null)).toBeUndefined();
    // An unset override showing the member's additions, unticked: « no addition » is a change.
    expect(save([], null, ["db"], [])).toEqual([]);
  });
});

describe("shownConnectionPick", () => {
  const below = { memberPinIds: null, softDefaultIds: [], resolvedIds: [] };

  it("shows the explicit pick, whatever the layers below hold", () => {
    const layers = { memberPinIds: ["pin"], softDefaultIds: ["soft"], resolvedIds: ["pin"] };
    expect(shownConnectionPick({ ...layers, explicitIds: ["a"] })).toEqual(["a"]);
    // An explicit "no connection" is a pick too, never the layers below.
    expect(shownConnectionPick({ ...layers, explicitIds: [] })).toEqual([]);
  });

  it("shows the member's pin under an unset pick, whole even when the server binds none of it", () => {
    // A pin with a member gone resolves to nothing; the stored set is still what is shown.
    const brokenPin = { ...below, explicitIds: null, memberPinIds: ["a", "gone"] };
    expect(shownConnectionPick(brokenPin)).toEqual(["a", "gone"]);
    // The member's own "no connection" is shown as such, not as nothing bound.
    expect(shownConnectionPick({ ...below, explicitIds: null, memberPinIds: [] })).toEqual([]);
  });

  it("shows a soft space default whole, then the set the fallback binds", () => {
    const unset = { explicitIds: null, memberPinIds: null };
    expect(
      shownConnectionPick({ ...unset, softDefaultIds: ["a", "gone"], resolvedIds: [] }),
    ).toEqual(["a", "gone"]);
    expect(shownConnectionPick({ ...unset, softDefaultIds: [], resolvedIds: ["own"] })).toEqual([
      "own",
    ]);
  });

  it("shows nothing when no layer chose and nothing binds", () => {
    expect(shownConnectionPick({ ...below, explicitIds: null })).toBeNull();
  });
});

describe("placeCreatedConnection", () => {
  const full = Array.from({ length: MAX_CONNECTIONS_PER_INTEGRATION }, (_, i) => `c${i}`);

  it("joins the shown pick, after its members", () => {
    expect(
      placeCreatedConnection({ boundIds: ["conn_a", "conn_b"], createdId: "conn_new" }),
    ).toEqual(["conn_a", "conn_b", "conn_new"]);
  });

  it("replaces a stored 'no connection' with the created connection", () => {
    expect(placeCreatedConnection({ boundIds: [], createdId: "conn_new" })).toEqual(["conn_new"]);
  });

  it("returns a full set unchanged: the cap refuses the addition", () => {
    expect(placeCreatedConnection({ boundIds: full, createdId: "conn_new" })).toBe(full);
  });

  it("caps the additions at what an imposed set leaves", () => {
    const additions = ["conn_a"];
    expect(placeCreatedConnection({ boundIds: additions, createdId: "conn_new", max: 1 })).toBe(
      additions,
    );
    expect(placeCreatedConnection({ boundIds: additions, createdId: "conn_new", max: 2 })).toEqual([
      "conn_a",
      "conn_new",
    ]);
  });

  describe("replacing an under-scoped member", () => {
    it("swaps it in place within a set, which keeps its size and order", () => {
      expect(
        placeCreatedConnection({
          boundIds: ["conn_a", "conn_old", "conn_b"],
          createdId: "conn_new",
          replacing: "conn_old",
        }),
      ).toEqual(["conn_a", "conn_new", "conn_b"]);
    });

    it("swaps a sole bound connection for the created one", () => {
      expect(
        placeCreatedConnection({
          boundIds: ["conn_old"],
          createdId: "conn_new",
          replacing: "conn_old",
        }),
      ).toEqual(["conn_new"]);
    });

    it("swaps inside a full set: the place it frees is the one it takes", () => {
      const swapped = placeCreatedConnection({
        boundIds: full,
        createdId: "conn_new",
        replacing: "c0",
      });
      expect(swapped).toEqual(["conn_new", ...full.slice(1)]);
    });

    it("adds plainly when the set does not hold the replaced member", () => {
      expect(
        placeCreatedConnection({
          boundIds: ["conn_a"],
          createdId: "conn_new",
          replacing: "conn_old",
        }),
      ).toEqual(["conn_a", "conn_new"]);
    });
  });
});

describe("unavailableConnectionIds", () => {
  it("names the stored members that are no candidate, in stored order", () => {
    expect(unavailableConnectionIds(["gone-2", "a", "gone-1"], ["a", "b"])).toEqual([
      "gone-2",
      "gone-1",
    ]);
  });

  it("is empty while every stored member is a candidate, and with nothing stored", () => {
    expect(unavailableConnectionIds(["a", "b"], ["a", "b", "c"])).toEqual([]);
    expect(unavailableConnectionIds([], ["a"])).toEqual([]);
  });
});

describe("withConnectionOverride", () => {
  it("replaces one integration's set, leaving the other picks and overrides", () => {
    const picks = { "@acme/a": ["1"], "@acme/b": ["2"] };
    const overrides = { model_id_override: "m", connection_overrides: picks };
    expect(withConnectionOverride(overrides, "@acme/a", ["3", "4"])).toEqual({
      model_id_override: "m",
      connection_overrides: { "@acme/a": ["3", "4"], "@acme/b": ["2"] },
    });
    expect(picks).toEqual({ "@acme/a": ["1"], "@acme/b": ["2"] });
  });

  it("removes the key for no pick, leaving the other picks", () => {
    const overrides = { connection_overrides: { "@acme/a": ["1"], "@acme/b": ["2"] } };
    expect(withConnectionOverride(overrides, "@acme/a", null)).toEqual({
      connection_overrides: { "@acme/b": ["2"] },
    });
  });

  it("drops `connection_overrides` once its last pick is cleared", () => {
    const overrides = { model_id_override: "m", connection_overrides: { "@acme/a": ["1"] } };
    expect(withConnectionOverride(overrides, "@acme/a", null)).toEqual({ model_id_override: "m" });
    expect(withConnectionOverride({}, "@acme/a", ["1"])).toEqual({
      connection_overrides: { "@acme/a": ["1"] },
    });
  });

  it("sends an override of 'no connection' as `[]` — the run starts without the integration", () => {
    expect(withConnectionOverride({}, "@acme/a", [])).toEqual({
      connection_overrides: { "@acme/a": [] },
    });
  });
});

describe("withDeclaredConnections", () => {
  const overrides = {
    model_id_override: "m",
    connection_overrides: { "@acme/a": ["1"], "@acme/gone": ["2"] },
  };

  it("drops a key the definition does not declare, keeping the declared ones as they are", () => {
    expect(withDeclaredConnections(overrides, ["@acme/a", "@acme/b"])).toEqual({
      model_id_override: "m",
      connection_overrides: { "@acme/a": ["1"] },
    });
  });

  it("drops `connection_overrides` when no key is declared any more", () => {
    expect(withDeclaredConnections(overrides, [])).toEqual({ model_id_override: "m" });
  });

  it("keeps every key while the declared set is unknown", () => {
    expect(withDeclaredConnections(overrides, undefined)).toBe(overrides);
  });
});
