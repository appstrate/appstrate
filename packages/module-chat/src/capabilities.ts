// SPDX-License-Identifier: Apache-2.0

// What a chat turn may do (persona, context block, web chip). The MCP server reads its
// grants off the routes; apps/api `catalog-requirements.test.ts` pins the two together.

import {
  agentCapabilities,
  PACKAGE_WRITE_PERMISSIONS,
  type RunLevel,
} from "@appstrate/core/permissions";
import type { ReachableSpaceGrant } from "@appstrate/core/module";

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
   * `transport` ∧ `skills:read`: the context lists the space's skills by their `skill://` URI, and
   * `read_resource`, which loads one, is registered on every platform MCP connection — no
   * dispatch needed. In the `manual` skill mode, `list_skills` lists them on the user's request.
   */
  readonly readsSkills: boolean;
  /**
   * `search_integration_tools` / `call_integration_tool` are offered: in at least one of the
   * turn's spaces, `mcp:invoke` and a credential-proxy permission hold and the space leaves the
   * proxy open (`credentialProxyOpen`) — the MCP server's per-space `proxies`, unioned org-wide.
   */
  readonly callsIntegrationTools: boolean;
}

const PROXY_PERMISSIONS = ["credential-proxy:call", "credential-proxy:call-own"];

/**
 * `has` is the turn's set; `spaces` are the turn's spaces, each acting with its own permissions
 * within that set. A judgement that names none (the web shell's, which judges no turn) counts no
 * integration tool, so it says so with `[]`.
 */
export function turnCapabilities(
  has: (permission: string) => boolean,
  spaces: readonly Pick<ReachableSpaceGrant, "permissions" | "credentialProxyOpen">[],
): TurnCapabilities {
  const transport = has("mcp:read");
  const invokes = transport && has("mcp:invoke");
  return {
    transport,
    invokes,
    ...agentCapabilities(has, invokes),
    authorsPackages: invokes && PACKAGE_WRITE_PERMISSIONS.some(has),
    readsSkills: transport && has("skills:read"),
    callsIntegrationTools:
      invokes &&
      spaces.some((space) => {
        const holds = (permission: string) =>
          has(permission) && space.permissions.includes(permission);
        return space.credentialProxyOpen && holds("mcp:invoke") && PROXY_PERMISSIONS.some(holds);
      }),
  };
}

/** Creating packages from the chat: the composer's authoring switch and the shell's access row. */
export function canAuthorPackages(has: (permission: string) => boolean): boolean {
  return has("chat:write") && turnCapabilities(has, []).authorsPackages;
}

/**
 * The skill picker: it writes the conversation and lists the space's skills,
 * whose content the chat then reads with the caller's own `skills:read`.
 */
export function canPinSkills(has: (permission: string) => boolean): boolean {
  return has("chat:write") && has("skills:read");
}
