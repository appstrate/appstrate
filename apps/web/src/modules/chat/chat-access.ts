// SPDX-License-Identifier: Apache-2.0

/**
 * What the chat assistant can do FOR the caller — the caller's RBAC standing,
 * translated into the handful of acts the assistant actually performs.
 *
 * The assistant runs on the caller's own permissions: the platform-MCP bearer
 * it authorizes with carries exactly the caller's effective set, no
 * amplification (`packages/module-chat/src/prompt.ts`). So "what may the
 * assistant do" and "what may I do" are the same question — and until now the
 * only way to learn the answer was to ask for something and read the refusal.
 *
 * This file is the ANSWER SHAPE, not a gate. Nothing here authorizes anything;
 * every act is re-checked server-side at invoke time. What it must be is
 * TRUTHFUL: a row that claims a capability the route would refuse is worse
 * than no row at all, which is why `activateIntegrations` asks
 * `maySetPackageActive` rather than a raw permission — the personal-space
 * exemption (RBAC spec §3.6) makes the bare grant the wrong question there.
 *
 * Deliberately NOT a dump of the effective permission set. That set is ~40
 * `resource:action` strings in English, most of which the chat never touches;
 * printing it would answer a question nobody asked while burying the one they
 * did ("why did it refuse me").
 */

import {
  PACKAGE_PERMISSIONS,
  maySetPackageActive,
  type SpaceGrant,
} from "../../lib/package-permissions";
import type { GateablePermission } from "../../hooks/use-permissions";

/** What a capability predicate gets to look at. */
export interface ChatAccessContext {
  /** The caller's org ∪ space effective set, as `usePermissions().can`. */
  can: (permission: GateablePermission) => boolean;
  /** The caller's standing in the current space; `undefined` while it loads. */
  spaceGrant: SpaceGrant | undefined;
}

export interface ChatCapability {
  /** Stable id — React keys and the tests index on it. */
  id: string;
  /**
   * Flat i18n key in the `chat` namespace, spelled in FULL rather than built
   * from `id`: the locale guard resolves string literals, so a spelled key is
   * checked both ways instead of needing a dynamic-prefix exemption.
   */
  labelKey: string;
  held: (ctx: ChatAccessContext) => boolean;
}

/**
 * Ordered from the widest to the narrowest, which is also roughly the order a
 * conversation hits them: reach the API at all, run something, look at what
 * ran, read the files it produced, then the two integration acts people
 * confuse for each other, then scheduling.
 */
export const CHAT_CAPABILITIES: readonly ChatCapability[] = [
  {
    // The whole tool surface. Without it the assistant answers from its own
    // words and nothing else — which is the single most useful thing to know.
    id: "callApi",
    labelKey: "access.capability.callApi",
    held: ({ can }) => can("mcp:invoke"),
  },
  {
    id: "runAgents",
    labelKey: "access.capability.runAgents",
    held: ({ can }) => can("agents:run"),
  },
  {
    id: "authorAgents",
    labelKey: "access.capability.authorAgents",
    held: ({ can }) => can("agents:write"),
  },
  {
    // `read-all` is the wider of the two and implies `read` (RBAC spec §3.4),
    // so either answers "may I see runs at all".
    id: "readRuns",
    labelKey: "access.capability.readRuns",
    held: ({ can }) => can("runs:read") || can("runs:read-all"),
  },
  {
    id: "readFiles",
    labelKey: "access.capability.readFiles",
    held: ({ can }) => can("files:read"),
  },
  {
    // Connecting is personal; activating is organization-wide. The chat's own
    // system prompt has to explain that distinction when an
    // `integration_not_active` error lands — showing both rows is what lets a
    // user see, before that happens, which half they hold.
    id: "connectIntegrations",
    labelKey: "access.capability.connectIntegrations",
    held: ({ can }) => can("integrations:connect"),
  },
  {
    // NOT `can(PACKAGE_PERMISSIONS.integration.activate)`: in a personal space
    // the owner may activate without holding the grant, and a row saying
    // otherwise would contradict the route. One rule, `maySetPackageActive`,
    // shared with every other activation control in the SPA.
    id: "activateIntegrations",
    labelKey: "access.capability.activateIntegrations",
    held: ({ spaceGrant }) => maySetPackageActive(spaceGrant, "integration", true),
  },
  {
    id: "schedule",
    labelKey: "access.capability.schedule",
    held: ({ can }) => can("schedules:write"),
  },
];

/** One capability, resolved for a caller. */
export interface ResolvedChatCapability extends ChatCapability {
  granted: boolean;
}

/** Every capability with its verdict, in declaration order. */
export function resolveChatCapabilities(ctx: ChatAccessContext): ResolvedChatCapability[] {
  return CHAT_CAPABILITIES.map((capability) => ({ ...capability, granted: capability.held(ctx) }));
}

/**
 * The permission the activation row reads, re-exported so a test pins the
 * coupling rather than re-spelling the string.
 */
export const INTEGRATION_ACTIVATE_PERMISSION = PACKAGE_PERMISSIONS.integration.activate;
