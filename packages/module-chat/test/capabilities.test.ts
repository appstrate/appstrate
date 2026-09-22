// SPDX-License-Identifier: Apache-2.0

/**
 * `turnCapabilities` is the one place "what may this turn do" is decided — the
 * persona, the caller-context block and the web access chip all read its answer.
 * So it is pinned exhaustively, against a spec written out longhand below rather
 * than against the core predicates it calls: re-spelling them here is what makes
 * a dropped conjunct show up as a disagreement instead of as two copies of the
 * same mistake.
 */

import { describe, expect, it } from "bun:test";
import { reaches, turnCapabilities, type RunLevel } from "../src/capabilities.ts";

/** Every permission any of the three rules reads. */
const UNIVERSE = [
  "mcp:read",
  "mcp:invoke",
  "agents:run",
  "agents:write",
  "runs:read",
  "runs:read-all",
] as const;

/** The rules, spelled out: no helper, no shared subexpression with the source. */
function spec(held: ReadonlySet<string>): {
  invokes: boolean;
  runLevel: RunLevel;
  authors: boolean;
} {
  const invokes = held.has("mcp:read") && held.has("mcp:invoke");
  const readsRuns = held.has("runs:read") || held.has("runs:read-all");
  const launches = held.has("agents:run") && readsRuns;
  const composes = launches && held.has("agents:write");
  const runLevel: RunLevel = !invokes
    ? "none"
    : composes
      ? "compose"
      : launches
        ? "run"
        : readsRuns
          ? "read"
          : "none";
  return { invokes, runLevel, authors: invokes && held.has("agents:write") };
}

describe("turnCapabilities", () => {
  it("agrees with the spec on every subset of the permissions it reads", () => {
    for (let mask = 0; mask < 1 << UNIVERSE.length; mask++) {
      const permissions = UNIVERSE.filter((_, i) => mask & (1 << i));
      const held = new Set<string>(permissions);
      expect({ permissions, ...turnCapabilities((p) => held.has(p)) }).toEqual({
        permissions,
        ...spec(held),
      });
    }
  });

  it("puts `invokes` in every level: no MCP pair, no run level and no authoring", () => {
    // The whole point of the type: a grant the turn cannot dispatch is a grant
    // it cannot use. Each case below holds every run/authoring permission and
    // drops one half of the pair.
    const acting = ["agents:run", "agents:write", "runs:read-all"];
    for (const transport of [[], ["mcp:read"], ["mcp:invoke"]]) {
      const held = new Set([...transport, ...acting]);
      expect(turnCapabilities((p) => held.has(p))).toEqual({
        invokes: false,
        runLevel: "none",
        authors: false,
      });
    }
    // Control: with both halves the same grants reach the top level.
    const full = new Set(["mcp:read", "mcp:invoke", ...acting]);
    expect(turnCapabilities((p) => full.has(p))).toEqual({
      invokes: true,
      runLevel: "compose",
      authors: true,
    });
  });
});

describe("reaches", () => {
  const ORDER: readonly RunLevel[] = ["none", "read", "run", "compose"];

  it("is true exactly when the level is at or above the floor", () => {
    for (const [i, level] of ORDER.entries()) {
      for (const [j, floor] of ORDER.entries()) {
        expect({ level, floor, reaches: reaches(level, floor) }).toEqual({
          level,
          floor,
          reaches: i >= j,
        });
      }
    }
  });
});
