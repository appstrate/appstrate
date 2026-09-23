// SPDX-License-Identifier: Apache-2.0

/**
 * What the chat assistant can do for the caller: their RBAC translated into the
 * assistant's acts, minus what the composer's agent-authoring switch turns off
 * (`turnPermissions`), never more. Not a gate — every act is re-checked
 * server-side — but a row must never claim what the route would refuse.
 *
 * The rows and the server's persona derive from ONE function, `turnCapabilities`
 * (`@appstrate/module-chat/capabilities`), so neither can drift from the other.
 * What stays local is what that derivation does not answer: `chat:write`, which
 * gates the composer rather than the turn, and `maySetPackageActive`.
 */

import {
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
  /** `turn` is derived once per resolution and handed to every row. */
  held: (ctx: ChatAccessContext, turn: TurnCapabilities) => boolean;
  /** A row the agent-authoring switch turns off: held, but not used this turn. */
  authoring?: true;
}

/**
 * Shared by the composer's agent-authoring toggle and the `createAgents` row.
 * `chat:write` is this surface's own conjunct: it gates the composer, not the
 * turn's capabilities.
 */
export function canAuthorAgents(ctx: Pick<ChatAccessContext, "can">): boolean {
  return ctx.can("chat:write") && turnCapabilities(ctx.can).authors;
}

/** The skill picker writes the conversation (`chat:write`) and lists skills the turn can load. */
export function canPinSkills(ctx: Pick<ChatAccessContext, "can">): boolean {
  return ctx.can("chat:write") && turnCapabilities(ctx.can).readsSkills;
}

const CHAT_CAPABILITIES: readonly ChatCapability[] = [
  {
    id: "callApi",
    labelKey: "access.capability.callApi",
    held: (_ctx, turn) => turn.invokes,
  },
  {
    // `run_and_wait` is not declared without run-read; a fire-and-forget run
    // the assistant could never report on does not count.
    id: "runAgents",
    labelKey: "access.capability.runAgents",
    held: (_ctx, turn) => reaches(turn.runLevel, "run"),
  },
  {
    // Creating only: editing an existing agent is authorized by its HOME space,
    // which for a shared agent is not this one.
    id: "createAgents",
    labelKey: "access.capability.createAgents",
    held: canAuthorAgents,
    authoring: true,
  },
  {
    id: "readRuns",
    labelKey: "access.capability.readRuns",
    held: (_ctx, turn) => reaches(turn.runLevel, "read"),
  },
  {
    // Browsing (`list_files`), not reading: `read_file` applies the file ACL,
    // not `files:read`, so a "read your files" row would deny what is allowed.
    // `mcp:read` alone reaches it — this is not an `invoke_operation` call.
    // `list_files` is declared when the `listFiles` operation's own guard is
    // granted (`buildMcpTools`, apps/api/src/modules/mcp/tools.ts); that guard
    // is `files:read` today, and this row tracks it.
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
