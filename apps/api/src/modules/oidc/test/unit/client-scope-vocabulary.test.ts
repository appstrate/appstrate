// SPDX-License-Identifier: Apache-2.0

/**
 * The scope vocabulary an OAuth client may register at, per client level
 * (issue #1372).
 *
 * `invalidScopesIn` is the single predicate behind `assertValidScopes`, which
 * every registration path funnels through (`createClient`,
 * `createInstanceClientFromEnv`, `updateClient`) and which
 * `instance-client-sync` consults before offering an operator a destructive
 * remedy. Pure — no DB — so the level matrix is asserted here rather than
 * through three integration flows.
 */

import { describe, it, expect } from "bun:test";
import { invalidScopesIn } from "../../services/oauth-admin.ts";

describe("client scope vocabulary", () => {
  it("admits a dashboard-only scope on instance and org clients", () => {
    expect(invalidScopesIn(["openid", "runs:read-all"], "org")).toEqual([]);
    expect(invalidScopesIn(["openid", "runs:read-all"], "instance")).toEqual([]);
  });

  it("refuses a dashboard-only scope on a space client, whose tokens cannot carry it", () => {
    expect(invalidScopesIn(["openid", "runs:read", "runs:read-all"], "space")).toEqual([
      "runs:read-all",
    ]);
  });

  it("refuses a scope outside the vocabulary at every level", () => {
    for (const level of ["instance", "org", "space"] as const) {
      expect(invalidScopesIn(["agents:delete"], level)).toEqual(["agents:delete"]);
    }
  });

  it("admits `agents:run-inline` on instance and org clients but refuses it on a space client", () => {
    // Dashboard-only, not absent: a dashboard token is capped by the subject's
    // live role, but a space client's tokens are end-user tokens, and an
    // end-user must never have the platform execute a manifest of the
    // embedding app's own composition. `agents:run` — launching an agent
    // someone in the org published — stays requestable at every level.
    expect(invalidScopesIn(["openid", "agents:run-inline"], "org")).toEqual([]);
    expect(invalidScopesIn(["openid", "agents:run-inline"], "instance")).toEqual([]);
    expect(invalidScopesIn(["openid", "agents:run", "agents:run-inline"], "space")).toEqual([
      "agents:run-inline",
    ]);
    for (const level of ["instance", "org", "space"] as const) {
      expect(invalidScopesIn(["agents:run"], level), level).toEqual([]);
    }
  });

  it("has nothing to validate for an absent or empty scope list", () => {
    expect(invalidScopesIn(undefined, "space")).toEqual([]);
    expect(invalidScopesIn([], "space")).toEqual([]);
  });
});
