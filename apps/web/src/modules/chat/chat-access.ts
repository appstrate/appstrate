// SPDX-License-Identifier: Apache-2.0

/**
 * What the chat assistant can do for the caller: their RBAC translated into the
 * assistant's acts (its MCP bearer carries the caller's grants in the spaces the
 * turn acts in, minus what the authoring switch turns off, never more). A verdict
 * says the act is held in some space of the turn, not in every one, and names those spaces.
 * Not a gate (acts are re-checked server-side), but a row must never claim what the route would
 * refuse; pinned to the routes' guards by `catalog-requirements.test.ts` (apps/api). These rows
 * judge the turn's own spaces, where `useChatCan` answers for any acting space: they differ on
 * purpose.
 */

import {
  canAuthorPackages,
  reaches,
  turnCapabilities,
  type TurnCapabilities,
} from "@appstrate/module-chat/capabilities";
import { maySetPackageActive, type SpaceGrant } from "../../lib/package-permissions";
import type { GateablePermission } from "../../hooks/use-permissions";

/** A space the turn acts in, with the caller's own grants there. */
export interface ActingSpaceGrant extends SpaceGrant {
  id: string;
}

export interface ChatAccessContext {
  /** The spaces the turn acts in; empty while they load, or when it acts nowhere. */
  spaces: readonly ActingSpaceGrant[];
  /** Org-level grants every space's gate adds (none for a limited conversation). */
  orgPermissions: readonly string[];
  /** The composer's package-authoring switch. */
  authoring: boolean;
}

/** What a capability reads of ONE acting space: its gate, org-level grants included, and its grant. */
interface InSpace {
  can: (permission: GateablePermission) => boolean;
  space: SpaceGrant;
}

export interface ChatCapability {
  id: string;
  /** Spelled in full, not built from `id`, so the locale guard checks it. */
  labelKey: string;
  held: (ctx: InSpace, turn: TurnCapabilities) => boolean;
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
    // Browsing (`list_files`), not reading: `read` applies the file ACL, not
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
    // Not the raw grant: a personal-space owner may activate without it.
    id: "activateIntegrations",
    labelKey: "access.capability.activateIntegrations",
    held: (ctx, turn) => turn.invokes && maySetPackageActive(ctx.space, "integration", true),
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
  /** The acting spaces that grant it, in the order given: what « Tous les espaces » names. */
  spaceIds: readonly string[];
}

/**
 * Each capability judged in each acting space alone, as the turn acts in one space at a time: it
 * is held where that space grants it, and granted when some acting space does. `chat:write` gates
 * the turn itself: a space where the caller may not write to the chat grants no row.
 */
export function resolveChatCapabilities(ctx: ChatAccessContext): ResolvedChatCapability[] {
  const judged = ctx.spaces.map((space) => {
    const can = (permission: string) =>
      ctx.orgPermissions.includes(permission) || space.permissions.includes(permission);
    return { id: space.id, inSpace: { can, space }, turn: turnCapabilities(can, []) };
  });
  return CHAT_CAPABILITIES.map((capability) => {
    const spaceIds = judged
      .filter(({ inSpace, turn }) => inSpace.can("chat:write") && capability.held(inSpace, turn))
      .map(({ id }) => id);
    return {
      ...capability,
      spaceIds,
      verdict:
        spaceIds.length === 0
          ? "denied"
          : capability.authoring && !ctx.authoring
            ? "off"
            : "granted",
    };
  });
}

/** The standing the summary names: the headline role and the line under the verdicts. */
interface AccessStanding {
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
