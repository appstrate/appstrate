// SPDX-License-Identifier: Apache-2.0

// What a chat turn may do (persona, context block, web chip). The MCP server reads its
// grants off the routes; apps/api `catalog-requirements.test.ts` pins the two together.

import { agentCapabilities, type RunLevel } from "@appstrate/core/permissions";

export { reaches, type RunLevel } from "@appstrate/core/permissions";

export interface TurnCapabilities {
  readonly invokes: boolean;
  readonly runLevel: RunLevel;
  readonly authors: boolean;
}

export function turnCapabilities(has: (permission: string) => boolean): TurnCapabilities {
  const invokes = has("mcp:read") && has("mcp:invoke");
  return { invokes, ...agentCapabilities(has, invokes) };
}

/** Creating agents from the chat: the composer's authoring switch and the shell's access row. */
export function canAuthorAgents(has: (permission: string) => boolean): boolean {
  return has("chat:write") && turnCapabilities(has).authors;
}
