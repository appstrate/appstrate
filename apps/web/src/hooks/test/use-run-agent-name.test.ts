// SPDX-License-Identifier: Apache-2.0

/**
 * The fallback chain that names the agent a run executed.
 *
 * A run outlives its agent, so every step here is a real state the list meets:
 * the agent is gone, the run was inline and never had one, the surface already
 * fixes it. The chain is tested through the pure half — the hook around it only
 * builds the map from the agents query.
 */

import { describe, it, expect } from "bun:test";
import type { EnrichedRun } from "@appstrate/shared-types";
import { resolveRunAgentName, type RunAgentNaming } from "../use-run-agent-name.ts";

/** The bundle is not loaded here: `t` returns the key, which is enough to assert WHICH label was picked. */
const t = ((key: string) => key) as unknown as RunAgentNaming["t"];

const naming = (over: Partial<RunAgentNaming> = {}): RunAgentNaming => ({
  byPackageId: new Map([["@acme/reporter", "Rapport trimestriel"]]),
  t,
  ...over,
});

const run = (over: Partial<EnrichedRun> = {}) =>
  ({ packageId: "@acme/reporter", agent_name: "reporter", ...over }) as unknown as EnrichedRun;

describe("resolveRunAgentName", () => {
  it("uses the agent's live display name", () => {
    expect(resolveRunAgentName(run(), naming())).toBe("Rapport trimestriel");
  });

  it("prefers the name the surface fixed, without consulting the map", () => {
    expect(resolveRunAgentName(run(), naming({ fixed: "Wiki-brain" }))).toBe("Wiki-brain");
  });

  it("falls back to the snapshot when the agent is not in the list", () => {
    // An agent from another workspace, or one the list has not loaded.
    expect(resolveRunAgentName(run({ packageId: "@acme/gone" }), naming())).toBe("reporter");
  });

  it("falls back to the package id when there is no snapshot either", () => {
    expect(resolveRunAgentName(run({ packageId: "@acme/gone", agent_name: null }), naming())).toBe(
      "@acme/gone",
    );
  });

  it("names a deleted agent rather than showing an empty cell", () => {
    // `packageId` is NULL after the FK SET NULL: the run survives its agent.
    expect(resolveRunAgentName(run({ packageId: null, agent_name: null }), naming())).toBe(
      "runs.deletedAgent",
    );
  });

  it("never returns nothing — the row's accessible label is built from it", () => {
    // Hiding the agent COLUMN used to blank the name too, which left every row
    // in an agent's tab announcing "Run #42 —".
    for (const r of [run(), run({ packageId: null }), run({ package_ephemeral: true })]) {
      expect(resolveRunAgentName(r, naming())).toBeTruthy();
    }
  });
});
