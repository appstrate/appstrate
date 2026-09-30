// SPDX-License-Identifier: Apache-2.0

/**
 * A member's catalogue is the union of their spaces' libraries. Pinned because
 * the screen reads it exactly as it reads an administrator's organization map.
 */

import { describe, it, expect } from "bun:test";
import { mergeSpaceLibraries } from "../merge-space-libraries.ts";
import type { LibraryPackageItem } from "../../hooks/use-library.ts";

function row(id: string, placements: LibraryPackageItem["placements"]): LibraryPackageItem {
  return {
    id,
    type: "agent",
    source: "local",
    name: id,
    description: "",
    home_space_id: "spc_home",
    home_writable: false,
    home_deletable: false,
    home_shareable: true,
    published: true,
    placements,
  };
}

const empty = { agent: [], skill: [], "mcp-server": [], integration: [] };

describe("mergeSpaceLibraries", () => {
  it("joins one package's placements across the spaces it was read from", () => {
    const merged = mergeSpaceLibraries([
      {
        spaces: [{ id: "spc_a", name: "A", isDefault: true }],
        packages: {
          ...empty,
          agent: [
            row("@o/x", [
              {
                space_id: "spc_a",
                via: "home",
                state: "active",
                chat_enforced: false,
                shared_by: null,
              },
            ]),
          ],
        },
      },
      {
        spaces: [{ id: "spc_b", name: "B", isDefault: false }],
        packages: {
          ...empty,
          agent: [
            row("@o/x", [
              {
                space_id: "spc_b",
                via: "shared",
                state: "none",
                chat_enforced: false,
                shared_by: null,
              },
            ]),
          ],
        },
      },
    ]);
    expect(merged.spaces.map((space) => space.id)).toEqual(["spc_a", "spc_b"]);
    expect(merged.packages.agent).toHaveLength(1);
    expect(merged.packages.agent[0]!.placements.map((p) => p.space_id)).toEqual(["spc_a", "spc_b"]);
  });

  it("keeps a candidate — a row with no placement — as the Découvrir half needs it", () => {
    const merged = mergeSpaceLibraries([
      {
        spaces: [{ id: "spc_a", name: "A", isDefault: true }],
        packages: { ...empty, agent: [row("@o/candidate", [])] },
      },
    ]);
    expect(merged.packages.agent[0]!.placements).toEqual([]);
  });

  it("puts the default space first, as the organization's own view does", () => {
    const merged = mergeSpaceLibraries([
      { spaces: [{ id: "spc_b", name: "B", isDefault: false }], packages: empty },
      { spaces: [{ id: "spc_a", name: "A", isDefault: true }], packages: empty },
    ]);
    expect(merged.spaces[0]!.id).toBe("spc_a");
  });
});
