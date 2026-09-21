// SPDX-License-Identifier: Apache-2.0

/**
 * What switching an agent on in a space leaves undone — the asymmetry between
 * the two dependency families, pinned because it is invisible on screen and
 * costly to rediscover: skills are judged from the agent's home, integrations
 * from the space that launches.
 */

import { describe, it, expect } from "bun:test";
import { missingIntegrations } from "../activation-closure.ts";
import type { LibraryPackageItem } from "../../hooks/use-library.ts";

function integration(
  id: string,
  placements: Array<{ space_id: string; state: "active" | "inactive" | "none" }>,
): LibraryPackageItem {
  return {
    id,
    type: "integration",
    source: "local",
    name: id.split("/").pop() ?? id,
    description: "",
    home_space_id: "spc_home",
    home_writable: true,
    home_deletable: true,
    home_shareable: true,
    placements: placements.map((p) => ({
      space_id: p.space_id,
      via: "home" as const,
      state: p.state,
      shared_by: null,
    })),
  };
}

const always = () => true;

describe("missingIntegrations", () => {
  it("names the ones the target space does not run", () => {
    const missing = missingIntegrations(
      [{ id: "@appstrate/gmail" }, { id: "@appstrate/drive" }],
      [
        integration("@appstrate/gmail", [{ space_id: "spc_b", state: "active" }]),
        integration("@appstrate/drive", [{ space_id: "spc_b", state: "inactive" }]),
      ],
      "spc_b",
      always,
    );
    expect(missing.map((entry) => entry.id)).toEqual(["@appstrate/drive"]);
  });

  it("counts a pending offer as missing: placed is not switched on", () => {
    const missing = missingIntegrations(
      [{ id: "@appstrate/gmail" }],
      [integration("@appstrate/gmail", [{ space_id: "spc_b", state: "none" }])],
      "spc_b",
      always,
    );
    expect(missing).toHaveLength(1);
  });

  it("judges the TARGET space, not another one the package is active in", () => {
    const missing = missingIntegrations(
      [{ id: "@appstrate/gmail" }],
      [integration("@appstrate/gmail", [{ space_id: "spc_a", state: "active" }])],
      "spc_b",
      always,
    );
    expect(missing.map((entry) => entry.id)).toEqual(["@appstrate/gmail"]);
  });

  it("says when the caller cannot switch one on rather than offering a refused button", () => {
    const missing = missingIntegrations(
      [{ id: "@appstrate/gmail" }],
      [integration("@appstrate/gmail", [])],
      "spc_b",
      () => false,
    );
    expect(missing[0]).toMatchObject({ id: "@appstrate/gmail", activatable: false });
  });

  it("stays silent about an integration this caller cannot see at all", () => {
    // Naming it would leak that it exists; the run gate says it in its own words.
    expect(missingIntegrations([{ id: "@other/secret" }], [], "spc_b", always)).toEqual([]);
  });
});
