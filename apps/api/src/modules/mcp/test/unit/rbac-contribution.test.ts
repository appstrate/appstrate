// SPDX-License-Identifier: Apache-2.0

/**
 * Which space-role presets the `mcp` resource reaches.
 *
 * The inbound MCP endpoint is a transport over the REST API, not a second
 * authority: every call it dispatches is re-checked against the principal's own
 * permissions. So `mcp:read` reaches every preset (a client that cannot list
 * the operations cannot discover what it is already allowed to call) and
 * `mcp:invoke` stops one short of `viewer`, at `runner` — the preset whose
 * whole point is launching agents through a friendly surface. Naming `runner`
 * is policy: drop it and a runner principal reaches the platform through the
 * REST routes but not through the tools built on them.
 *
 * Asserted here rather than against the merged matrix in
 * `apps/api/test/unit/permissions.test.ts`: the aggregated snapshot is a
 * process-wide singleton several suites reset, so only the declaration itself
 * is deterministic.
 */
import { describe, expect, it } from "bun:test";
import { SPACE_ROLE_PRESETS } from "@appstrate/core/permissions";
import mcpModule from "../../index.ts";

/** The `presets` list declared for `mcp:<action>`, at `level: "space"`. */
function presetsFor(action: "read" | "invoke"): readonly string[] {
  const entry = mcpModule
    .permissionsContribution?.()
    .find(
      (contribution) => contribution.resource === "mcp" && contribution.actions.includes(action),
    );
  if (entry === undefined || entry.level !== "space") {
    throw new Error(`the mcp module declares no space-level contribution for mcp:${action}`);
  }
  return entry.presets;
}

describe("mcp RBAC contribution", () => {
  it("reads reach every preset, invokes stop at `runner`", () => {
    expect(presetsFor("read")).toEqual([...SPACE_ROLE_PRESETS]);
    expect(presetsFor("invoke")).toEqual(["admin", "builder", "operator", "runner"]);
  });

  it("names only presets the platform knows", () => {
    const known: readonly string[] = SPACE_ROLE_PRESETS;
    for (const action of ["read", "invoke"] as const) {
      for (const preset of presetsFor(action)) {
        expect(known.includes(preset), `mcp:${action} names ${preset}`).toBe(true);
      }
    }
  });
});
