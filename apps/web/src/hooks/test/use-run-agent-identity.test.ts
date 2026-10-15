// SPDX-License-Identifier: Apache-2.0

/**
 * Which tile a run's agent wears.
 *
 * A run snapshots a name but no icon, so the tile is read off the agents the
 * org can see; every run the list cannot place (deleted agent, inline shadow,
 * an agent from elsewhere) resolves to `{}`, which draws as the default tile.
 */

import { describe, it, expect } from "bun:test";
import type { EnrichedRun } from "@appstrate/shared-types";
import { makeRun } from "../../test/run-fixture.ts";
import { resolveRunAgentIdentity, type RunAgentIdentity } from "../use-run-agent-identity.ts";

const byPackageId = new Map<string, RunAgentIdentity>([
  ["@acme/reporter", { icon: "lucide:chart-bar", color: "#2563eb" }],
]);

const run = (over: Partial<EnrichedRun> = {}) =>
  makeRun({ packageId: "@acme/reporter", package_ephemeral: false, ...over });

describe("resolveRunAgentIdentity", () => {
  it("reads the tile of the agent the run executed", () => {
    expect(resolveRunAgentIdentity(run(), byPackageId)).toEqual({
      icon: "lucide:chart-bar",
      color: "#2563eb",
    });
  });

  it("is empty for an agent the list does not hold", () => {
    expect(resolveRunAgentIdentity(run({ packageId: "@acme/gone" }), byPackageId)).toEqual({});
  });

  it("is empty for a deleted agent (FK SET NULL)", () => {
    expect(resolveRunAgentIdentity(run({ packageId: null }), byPackageId)).toEqual({});
  });

  it("is empty for an inline run, whose shadow package is no agent's", () => {
    const inline = run({ packageId: "@acme/reporter", package_ephemeral: true });
    expect(resolveRunAgentIdentity(inline, byPackageId)).toEqual({});
  });
});
