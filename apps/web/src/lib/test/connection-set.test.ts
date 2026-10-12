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
  canApplyConnectionSet,
  placeCreatedConnection,
  shownConnectionPick,
  unavailableConnectionIds,
  withConnectionOverride,
  withDeclaredConnections,
  withFallbackConnections,
  type FallbackBindingEntry,
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
});

describe("keepAvailable", () => {
  it("drops an id that is not available, keeping order", () => {
    expect(keepAvailable(["b", "gone", "a"], ["a", "b"])).toEqual(["b", "a"]);
  });
});

describe("canApplyConnectionSet", () => {
  const a = { id: "conn_a" };
  const b = { id: "conn_b" };

  it("refuses the empty set and the stored pick, in any order", () => {
    // Control: a touched set that differs from the stored pick is writable.
    expect(canApplyConnectionSet([a, b], null, true)).toBe(true);
    expect(canApplyConnectionSet([], null, true)).toBe(false);
    expect(canApplyConnectionSet([b, a], ["conn_a", "conn_b"], true)).toBe(false);
  });

  it("never writes [] — 'no connection' is its own entry — but replaces a stored one", () => {
    expect(canApplyConnectionSet([], [], true)).toBe(false);
    expect(canApplyConnectionSet([a], [], true)).toBe(true);
    // Untouched over a stored "none", nothing is ticked: nothing to write.
    expect(canApplyConnectionSet([], [], false)).toBe(false);
  });

  it("refuses an untouched menu ticked from the default an unset pick shows", () => {
    // Writing it would pin {a, b} and detach the member from later org-default
    // changes. Control: the same ticks after an actual edit are writable.
    expect(canApplyConnectionSet([a, b], null, false)).toBe(false);
    expect(canApplyConnectionSet([a, b], null, true)).toBe(true);
  });

  it("lets the actor rewrite a stored pick naming an unavailable connection, while a member survives", () => {
    // Nothing was ticked or unticked, yet the stored set differs from what a
    // write would send: without this the ghost id could never be dropped.
    expect(canApplyConnectionSet([a], ["conn_a", "conn_unshared"], false)).toBe(true);
    // Control: an untouched pick with no ghost has nothing to rewrite.
    expect(canApplyConnectionSet([a], ["conn_a"], false)).toBe(false);
    // No member survives: the set left to write is empty, which "Valider" never writes.
    expect(canApplyConnectionSet([], ["conn_unshared"], false)).toBe(false);
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

const GMAIL = "@acme/gmail";
const entry = (
  id: string,
  resolution: Partial<FallbackBindingEntry["resolution"]> = {},
): FallbackBindingEntry => ({
  integration_package_id: id,
  inert: false,
  resolution: {
    source: "fallback_auto",
    resolved_connection_ids: ["c_own"],
    ...resolution,
  },
});

describe("withFallbackConnections", () => {
  const picksOf = (picks: Record<string, string[]> | undefined, readiness = [entry(GMAIL)]) => {
    const overrides = picks ? { connection_overrides: picks } : {};
    return withFallbackConnections(overrides, readiness).connection_overrides;
  };

  it("names the set the fallback binds", () => {
    expect(picksOf(undefined)).toEqual({ [GMAIL]: ["c_own"] });
  });

  it("names nothing a layer already names, nor an integration nothing binds", () => {
    const readiness = [
      entry(GMAIL, { source: "member_pin" }),
      entry("@acme/slack", { source: "org_default" }),
      entry("@acme/notion", { source: "org_default_enforced" }),
      entry("@acme/ssh", { source: "admin_pin" }),
      entry("@acme/crm", { source: null, resolved_connection_ids: [] }),
    ];
    expect(picksOf(undefined, readiness)).toBeUndefined();
  });

  it("names the fallback's set whatever its health", () => {
    // Readiness keeps the bound ids beside a health `error_code`.
    const { resolution, ...rest } = entry(GMAIL);
    const dead = { ...rest, resolution: { ...resolution, error_code: "needs_reconnection" } };
    expect(picksOf(undefined, [dead])).toEqual({ [GMAIL]: ["c_own"] });
  });

  it("names nothing for an inert integration: no run binds it", () => {
    expect(picksOf(undefined, [{ ...entry(GMAIL), inert: true }])).toBeUndefined();
  });

  it("gives way to a pick, 'no connection' included", () => {
    expect(picksOf({ [GMAIL]: ["c_other"] })).toEqual({ [GMAIL]: ["c_other"] });
    expect(picksOf({ [GMAIL]: [] })).toEqual({ [GMAIL]: [] });
    const slack = { "@acme/slack": ["c_slack"] };
    expect(picksOf(slack)).toEqual({ ...slack, [GMAIL]: ["c_own"] });
  });

  it("keeps the other overrides, and the value itself without a verdict", () => {
    const overrides = { model_id_override: "m1" };
    expect(withFallbackConnections(overrides, [entry(GMAIL)])).toEqual({
      model_id_override: "m1",
      connection_overrides: { [GMAIL]: ["c_own"] },
    });
    expect(withFallbackConnections(overrides, undefined)).toBe(overrides);
  });
});
