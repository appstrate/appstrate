// SPDX-License-Identifier: Apache-2.0

// What a chat turn may do (persona, context block, web chip). The MCP server reads its
// grants off the routes; apps/api `catalog-requirements.test.ts` pins the two together.

import {
  agentCapabilities,
  PACKAGE_WRITE_PERMISSIONS,
  type RunLevel,
} from "@appstrate/core/permissions";

export { reaches, type RunLevel } from "@appstrate/core/permissions";

export interface TurnCapabilities {
  /** `mcp:read`: the platform MCP transport — without it the turn holds no tool at all. */
  readonly transport: boolean;
  readonly invokes: boolean;
  readonly runLevel: RunLevel;
  readonly authors: boolean;
  /** Dispatch ∧ a write on any package type: the turn may create a package of that type. */
  readonly authorsPackages: boolean;
  /**
   * `transport` ∧ `skills:read`: the context lists the space's skills on `skills:read`, and
   * `read_skill`, which loads one, is declared on every MCP connection — no dispatch needed.
   */
  readonly readsSkills: boolean;
}

export function turnCapabilities(has: (permission: string) => boolean): TurnCapabilities {
  const transport = has("mcp:read");
  const invokes = transport && has("mcp:invoke");
  return {
    transport,
    invokes,
    ...agentCapabilities(has, invokes),
    authorsPackages: invokes && PACKAGE_WRITE_PERMISSIONS.some(has),
    readsSkills: transport && has("skills:read"),
  };
}

/** Creating packages from the chat: the composer's authoring switch and the shell's access row. */
export function canAuthorPackages(has: (permission: string) => boolean): boolean {
  return has("chat:write") && turnCapabilities(has).authorsPackages;
}

/**
 * The skill picker: it writes the conversation and lists the space's skills,
 * whose content the chat then reads with the caller's own `skills:read`.
 */
export function canPinSkills(has: (permission: string) => boolean): boolean {
  return has("chat:write") && has("skills:read");
}
