// SPDX-License-Identifier: Apache-2.0

/**
 * What a chat turn may do, derived ONCE from the permission set that turn acts
 * with. The persona (`prompt.ts`), the caller-context block and the web access
 * chip (`apps/web/src/modules/chat/chat-access.ts`) all read this shape, so
 * "authors" cannot mean a different conjunction in each of the three. The
 * vocabulary-free half lives in core (`agentCapabilities`), which the MCP
 * server derives its own tool set and instructions from.
 */

import { agentCapabilities, type RunLevel } from "@appstrate/core/permissions";

export { reaches, type RunLevel } from "@appstrate/core/permissions";

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
  const invokes = has("mcp:read") && has("mcp:invoke");
  return { invokes, ...agentCapabilities(has, invokes) };
}
