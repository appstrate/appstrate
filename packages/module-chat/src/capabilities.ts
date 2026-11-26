// SPDX-License-Identifier: Apache-2.0

// What a chat turn may do (persona, context block, web chip). The MCP server reads its
// grants off the routes; apps/api `catalog-requirements.test.ts` pins the two together.

import {
  agentCapabilities,
  PACKAGE_WRITE_PERMISSIONS,
  reaches,
  type RunLevel,
} from "@appstrate/core/permissions";
import type { ReachableSpaceGrant } from "@appstrate/core/module";
import { spaceActs, type SpaceAct } from "@appstrate/core/mcp-spaces";

export { limitedConversationPermissions } from "./turn-permissions.ts";
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
   * dispatch needed.
   */
  readonly readsSkills: boolean;
  /**
   * `transport` ∧ `integrations:read`: `get_me` (declared on every platform MCP connection) lists
   * the caller's connected integrations in a space — `GET /api/me/context` reads the same grant for them.
   */
  readonly readsConnections: boolean;
  /**
   * The integration tools (`search`'s `integration_tool` kind, `call_integration_tool`) are offered: in at least one of the
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
    readsConnections: transport && has("integrations:read"),
    callsIntegrationTools:
      invokes &&
      spaces.some((space) => {
        const holds = (permission: string) =>
          has(permission) && space.permissions.includes(permission);
        return space.credentialProxyOpen && holds("mcp:invoke") && PROXY_PERMISSIONS.some(holds);
      }),
  };
}

/**
 * What the turn may do in one of its spaces: {@link turnCapabilities} over the permissions held
 * both by the turn (`has`) and in that space, in the vocabulary `get_me` names them with (its
 * `spaces[].can`, which apps/api `catalog-requirements.test.ts` pins to this).
 */
export function spaceActsInTurn(
  has: (permission: string) => boolean,
  space: Pick<ReachableSpaceGrant, "permissions" | "credentialProxyOpen">,
): SpaceAct[] {
  const holds = (permission: string) => has(permission) && space.permissions.includes(permission);
  const capabilities = turnCapabilities(holds, [space]);
  return spaceActs({
    invoke_operations: capabilities.invokes,
    run_agents: reaches(capabilities.runLevel, "run"),
    inline_runs: reaches(capabilities.runLevel, "compose"),
    call_integration_tools: capabilities.callsIntegrationTools,
    create_packages: capabilities.authorsPackages,
  });
}

/** Creating packages from the chat: the composer's authoring switch and the shell's access row. */
export function canAuthorPackages(has: (permission: string) => boolean): boolean {
  return has("chat:write") && turnCapabilities(has, []).authorsPackages;
}

/** Composing inline runs from the chat: the composer's inline-run model switch. */
export function canComposeInlineRuns(has: (permission: string) => boolean): boolean {
  return has("chat:write") && turnCapabilities(has, []).runLevel === "compose";
}

/**
 * The skill picker: it writes the conversation and lists the space's skills,
 * whose content the chat then reads with the caller's own `skills:read`.
 */
export function canPinSkills(has: (permission: string) => boolean): boolean {
  return has("chat:write") && has("skills:read");
}
