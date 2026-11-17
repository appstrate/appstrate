// SPDX-License-Identifier: Apache-2.0

/**
 * What the chat assistant can do for the caller: their RBAC translated into the
 * assistant's acts (its MCP bearer carries the caller's grants in the spaces the
 * turn acts in, minus what the authoring switch turns off, never more). A verdict
 * says the act is held in some space of the turn, not in every one. Not a gate (acts are re-checked
 * server-side), but a row must never claim what the route would refuse; pinned
 * to the routes' guards by `catalog-requirements.test.ts` (apps/api).
 */

import {
  canAuthorPackages,
  reaches,
  turnCapabilities,
  type TurnCapabilities,
} from "@appstrate/module-chat/capabilities";
import { maySetPackageActive, type SpaceGrant } from "../../lib/package-permissions";
import type { GateablePermission } from "../../hooks/use-permissions";

export interface ChatAccessContext {
  /** Held in some space the chat acts in: the union the turn's capabilities read (`useChatCan`). */
  can: (permission: GateablePermission) => boolean;
  /** The caller's standing in each space the chat acts in; empty while they load. */
  spaceGrants: readonly SpaceGrant[];
  /** The composer's package-authoring switch. */
  authoring: boolean;
}

export interface ChatCapability {
  id: string;
  /** Spelled in full, not built from `id`, so the locale guard checks it. */
  labelKey: string;
  held: (ctx: ChatAccessContext, turn: TurnCapabilities) => boolean;
  /** A row the package-authoring switch turns off: held, but not used this turn. */
  authoring?: true;
}

const CHAT_CAPABILITIES: readonly ChatCapability[] = [
  {
    id: "callApi",
    labelKey: "access.capability.callApi",
    held: (_ctx, turn) => turn.invokes,
  },
  {
    // `run_and_wait` is not declared without run-read.
    id: "runAgents",
    labelKey: "access.capability.runAgents",
    held: (_ctx, turn) => reaches(turn.runLevel, "run"),
  },
  {
    // Creating only: editing is authorized by the agent's HOME space.
    id: "createPackages",
    labelKey: "access.capability.createPackages",
    held: (ctx) => canAuthorPackages(ctx.can),
    authoring: true,
  },
  {
    id: "readRuns",
    labelKey: "access.capability.readRuns",
    held: (_ctx, turn) => reaches(turn.runLevel, "read"),
  },
  {
    // Browsing (`list_files`), not reading: `read_file` applies the file ACL, not
    // `files:read`. A tool of its own, so no `mcp:invoke`.
    id: "browseFiles",
    labelKey: "access.capability.browseFiles",
    held: (ctx) => ctx.can("mcp:read") && ctx.can("files:read"),
  },
  {
    // Connecting is personal; activating (next row) is per space.
    id: "connectIntegrations",
    labelKey: "access.capability.connectIntegrations",
    held: (ctx, turn) => turn.invokes && ctx.can("integrations:connect"),
  },
  {
    // Not the raw grant: a personal-space owner may activate without it. Held when some space
    // the chat acts in allows it.
    id: "activateIntegrations",
    labelKey: "access.capability.activateIntegrations",
    held: (ctx, turn) =>
      turn.invokes &&
      ctx.spaceGrants.some((grant) => maySetPackageActive(grant, "integration", true)),
  },
  {
    id: "schedule",
    labelKey: "access.capability.schedule",
    held: (ctx, turn) => turn.invokes && ctx.can("schedules:write"),
  },
];

type ChatCapabilityVerdict = "granted" | "off" | "denied";

export interface ResolvedChatCapability extends ChatCapability {
  verdict: ChatCapabilityVerdict;
}

/** `chat:write` gates the turn itself: a `chat:read`-only caller holds no row. */
export function resolveChatCapabilities(ctx: ChatAccessContext): ResolvedChatCapability[] {
  const converses = ctx.can("chat:write");
  const turn = turnCapabilities(ctx.can, []);
  return CHAT_CAPABILITIES.map((capability) => ({
    ...capability,
    verdict: !(converses && capability.held(ctx, turn))
      ? "denied"
      : capability.authoring && !ctx.authoring
        ? "off"
        : "granted",
  }));
}

/** The standing the summary names: the headline role and the line under the verdicts. */
export interface AccessStanding {
  headline: string;
  line: {
    key: "access.roleLine" | "access.roleLineOrg" | "access.roleLineIn";
    params: Record<string, string>;
  };
}

/**
 * The standing to name. With a space selected: the caller's role there (else the org role) and
 * both in the line. In « Tous les espaces » the working space is unseen, so it is never named:
 * the org role heads, and the line adds the conversation's origin space by name with the role
 * held there, when it has one.
 */
export function accessStanding(input: {
  overview: boolean;
  orgRole: string;
  /** The role in the working space, `null` for none. */
  workingRole: string | null;
  /** The conversation's origin space, by name, with the role held there. */
  origin: { name: string; role: string | null } | null;
}): AccessStanding {
  const { overview, orgRole, workingRole, origin } = input;
  if (!overview) {
    return {
      headline: workingRole ?? orgRole,
      line: { key: "access.roleLine", params: { org: orgRole, space: workingRole ?? "—" } },
    };
  }
  return {
    headline: orgRole,
    line: origin
      ? {
          key: "access.roleLineIn",
          params: { org: orgRole, name: origin.name, space: origin.role ?? "—" },
        }
      : { key: "access.roleLineOrg", params: { org: orgRole } },
  };
}
