// SPDX-License-Identifier: Apache-2.0

/**
 * What a chat turn may do, derived ONCE from the permission set that turn acts
 * with. The persona (`prompt.ts`), the caller-context block and the web access
 * chip (`apps/web/src/modules/chat/chat-access.ts`) all read this shape, so
 * "authors" cannot mean a different conjunction in each of the three.
 */

import { canComposeInline, canReadRuns, canRunAgents } from "@appstrate/core/permissions";

/** How far a turn gets with runs. Ordered: each level implies the previous one. */
export type RunLevel = "none" | "read" | "run" | "compose";

const RUN_LEVELS: readonly RunLevel[] = ["none", "read", "run", "compose"];

export interface TurnCapabilities {
  /**
   * `mcp:read` ∧ `mcp:invoke` — the transport floor and the dispatching tool;
   * nothing reaches a route without both.
   */
  readonly invokes: boolean;
  /** How far the turn gets with runs; each level implies the previous. */
  readonly runLevel: RunLevel;
  /** `invokes` ∧ `agents:write`: authoring only matters when `createAgent` can be invoked. */
  readonly authors: boolean;
}

/** Derive the turn's capabilities from a membership test over its permissions. */
export function turnCapabilities(has: (permission: string) => boolean): TurnCapabilities {
  // `invokes` is a conjunct of every level: a grant the turn cannot dispatch is
  // a grant it cannot use, and claiming it buys a refusal nobody can explain.
  const invokes = has("mcp:read") && has("mcp:invoke");
  const runLevel: RunLevel = !invokes
    ? "none"
    : canRunAgents(has)
      ? canComposeInline(has)
        ? "compose"
        : "run"
      : canReadRuns(has)
        ? "read"
        : "none";
  return { invokes, runLevel, authors: invokes && has("agents:write") };
}

/** Whether `level` reaches at least `floor` on the ordered scale. */
export function reaches(level: RunLevel, floor: RunLevel): boolean {
  return RUN_LEVELS.indexOf(level) >= RUN_LEVELS.indexOf(floor);
}
