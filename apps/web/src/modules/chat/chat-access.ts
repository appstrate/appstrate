// SPDX-License-Identifier: Apache-2.0

/**
 * What the chat assistant can do for the caller. It acts through an MCP bearer
 * carrying the caller's effective set — minus what the composer's
 * agent-authoring switch turns off (`turnPermissions`), never more — so this is
 * the caller's RBAC translated into the assistant's acts. Not a gate — every act is re-checked
 * server-side — but a row must never claim what the route would refuse.
 */

import { maySetPackageActive, type SpaceGrant } from "../../lib/package-permissions";
import type { GateablePermission } from "../../hooks/use-permissions";

export interface ChatAccessContext {
  /** The caller's org ∪ space effective set, as `usePermissions().can`. */
  can: (permission: GateablePermission) => boolean;
  /** The caller's standing in the current space; `undefined` while it loads. */
  spaceGrant: SpaceGrant | undefined;
}

export interface ChatCapability {
  id: string;
  /** Spelled in full, not built from `id`, so the locale guard checks it. */
  labelKey: string;
  held: (ctx: ChatAccessContext) => boolean;
}

/** The MCP transport admits nobody without `mcp:read` (`mcp/router.ts`). */
function reachesMcp({ can }: Pick<ChatAccessContext, "can">): boolean {
  return can("mcp:read");
}

/** Both acting tools refuse without `mcp:invoke`; the route then checks its own. */
function invokes(ctx: Pick<ChatAccessContext, "can">): boolean {
  return reachesMcp(ctx) && ctx.can("mcp:invoke");
}

/** Shared by the composer's agent-authoring toggle and the `createAgents` row. */
export function canAuthorAgents(ctx: Pick<ChatAccessContext, "can">): boolean {
  return ctx.can("chat:write") && invokes(ctx) && ctx.can("agents:write");
}

/** Mirrors server-side `canReadRuns`: `read-all` implies `read`. */
function readsRuns({ can }: ChatAccessContext): boolean {
  return can("runs:read") || can("runs:read-all");
}

const CHAT_CAPABILITIES: readonly ChatCapability[] = [
  {
    id: "callApi",
    labelKey: "access.capability.callApi",
    held: invokes,
  },
  {
    // `run_and_wait` refuses without run-read before launching; a fire-and-forget
    // run the assistant could never report on does not count.
    id: "runAgents",
    labelKey: "access.capability.runAgents",
    held: (ctx) => invokes(ctx) && readsRuns(ctx) && ctx.can("agents:run"),
  },
  {
    // Creating only: editing an existing agent is authorized by its HOME space,
    // which for a shared agent is not this one.
    id: "createAgents",
    labelKey: "access.capability.createAgents",
    held: canAuthorAgents,
  },
  {
    id: "readRuns",
    labelKey: "access.capability.readRuns",
    held: (ctx) => invokes(ctx) && readsRuns(ctx),
  },
  {
    // Browsing (`list_files`), not reading: `read_file` applies the file ACL,
    // not `files:read`, so a "read your files" row would deny what is allowed.
    id: "browseFiles",
    labelKey: "access.capability.browseFiles",
    held: (ctx) => reachesMcp(ctx) && ctx.can("files:read"),
  },
  {
    // Connecting is personal; activating (next row) is per space.
    id: "connectIntegrations",
    labelKey: "access.capability.connectIntegrations",
    held: (ctx) => invokes(ctx) && ctx.can("integrations:connect"),
  },
  {
    // Not the raw grant: a personal-space owner may activate without it.
    id: "activateIntegrations",
    labelKey: "access.capability.activateIntegrations",
    held: (ctx) => invokes(ctx) && maySetPackageActive(ctx.spaceGrant, "integration", true),
  },
  {
    id: "schedule",
    labelKey: "access.capability.schedule",
    held: (ctx) => invokes(ctx) && ctx.can("schedules:write"),
  },
];

export interface ResolvedChatCapability extends ChatCapability {
  granted: boolean;
}

/** `chat:write` gates the turn itself: a `chat:read`-only caller holds no row. */
export function resolveChatCapabilities(ctx: ChatAccessContext): ResolvedChatCapability[] {
  const converses = ctx.can("chat:write");
  return CHAT_CAPABILITIES.map((capability) => ({
    ...capability,
    granted: converses && capability.held(ctx),
  }));
}
