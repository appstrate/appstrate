// SPDX-License-Identifier: Apache-2.0

/**
 * What the chat assistant can do for the caller: their RBAC translated into the
 * assistant's acts (its MCP bearer carries the caller's set minus what the
 * authoring switch turns off, never more). Not a gate (acts are re-checked
 * server-side), but a row must never claim what the route would refuse; pinned
 * to the routes' guards by `catalog-requirements.test.ts` (apps/api).
 */

import {
  canAuthorAgents,
  reaches,
  turnCapabilities,
  type TurnCapabilities,
} from "@appstrate/module-chat/capabilities";
import { maySetPackageActive, type SpaceGrant } from "../../lib/package-permissions";
import type { GateablePermission } from "../../hooks/use-permissions";

export interface ChatAccessContext {
  /** The caller's org ∪ space effective set, as `usePermissions().can`. */
  can: (permission: GateablePermission) => boolean;
  /** The caller's standing in the current space; `undefined` while it loads. */
  spaceGrant: SpaceGrant | undefined;
  /** The composer's agent-authoring switch. */
  authoring: boolean;
}

export interface ChatCapability {
  id: string;
  /** Spelled in full, not built from `id`, so the locale guard checks it. */
  labelKey: string;
  held: (ctx: ChatAccessContext, turn: TurnCapabilities) => boolean;
  /** A row the agent-authoring switch turns off: held, but not used this turn. */
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
    id: "createAgents",
    labelKey: "access.capability.createAgents",
    held: (ctx) => canAuthorAgents(ctx.can),
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
    // Not the raw grant: a personal-space owner may activate without it.
    id: "activateIntegrations",
    labelKey: "access.capability.activateIntegrations",
    held: (ctx, turn) => turn.invokes && maySetPackageActive(ctx.spaceGrant, "integration", true),
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
  const turn = turnCapabilities(ctx.can);
  return CHAT_CAPABILITIES.map((capability) => ({
    ...capability,
    verdict: !(converses && capability.held(ctx, turn))
      ? "denied"
      : capability.authoring && !ctx.authoring
        ? "off"
        : "granted",
  }));
}
