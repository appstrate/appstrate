// SPDX-License-Identifier: Apache-2.0

/**
 * The run-level and authoring rules are core's (`agentCapabilities`) and are
 * pinned exhaustively in `packages/core/test/permissions.test.ts`. What is this
 * module's own is `invokes` — the transport conjunction core does not know —
 * and that it gates every level, so that is what is pinned here.
 */

import { describe, expect, it } from "bun:test";
import { turnCapabilities } from "../src/capabilities.ts";

describe("turnCapabilities", () => {
  it("puts `invokes` in every level: no MCP pair, no run level and no authoring", () => {
    // The whole point of the type: a grant the turn cannot dispatch is a grant
    // it cannot use. Each case below holds every run/authoring permission and
    // drops one half of the pair.
    const acting = ["agents:run", "agents:write", "runs:read-all", "skills:read"];
    for (const transport of [[], ["mcp:read"], ["mcp:invoke"]]) {
      const held = new Set([...transport, ...acting]);
      expect(turnCapabilities((p) => held.has(p))).toEqual({
        invokes: false,
        runLevel: "none",
        authors: false,
        readsSkills: false,
      });
    }
    // Control: with both halves the same grants reach the top level.
    const full = new Set(["mcp:read", "mcp:invoke", ...acting]);
    expect(turnCapabilities((p) => full.has(p))).toEqual({
      invokes: true,
      runLevel: "compose",
      authors: true,
      readsSkills: true,
    });
  });
});
