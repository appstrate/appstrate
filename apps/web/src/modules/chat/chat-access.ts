// SPDX-License-Identifier: Apache-2.0

/**
 * What the chat assistant can do FOR the caller — the caller's RBAC standing,
 * translated into the handful of acts the assistant actually performs.
 *
 * The assistant runs on the caller's own permissions: the platform-MCP bearer
 * it authorizes with carries exactly the caller's effective set, no
 * amplification (`packages/module-chat/src/prompt.ts`). So "what may the
 * assistant do" and "what may I do" are the same question, and this table
 * answers it before the caller has to ask for something and read the refusal.
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

import { maySetPackageActive, type SpaceGrant } from "../../lib/package-permissions";
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
 * The platform-MCP endpoint admits nobody without `mcp:read`
 * (`apps/api/src/modules/mcp/router.ts`, `requireModulePermission("mcp",
 * "read")` on the transport path) — every tool the assistant has lives behind
 * it, including the read-only ones.
 */
function reachesMcp({ can }: ChatAccessContext): boolean {
  return can("mcp:read");
}

/**
 * Every ACT the assistant performs goes through `invoke_operation` or
 * `run_and_wait`, and both refuse before dispatching when the caller lacks
 * `mcp:invoke` (`apps/api/src/modules/mcp/tools.ts`). The dispatched route then
 * enforces its own permission on top — so a row is the conjunction, never
 * either half alone.
 */
function invokes(ctx: ChatAccessContext): boolean {
  return reachesMcp(ctx) && ctx.can("mcp:invoke");
}

/**
 * The disjunction `canReadRuns` applies server-side
 * (`apps/api/src/lib/run-visibility.ts`): `read-all` is the wider of the two
 * and implies `read` (RBAC spec §3.4), so either opens every run-read surface.
 */
function readsRuns({ can }: ChatAccessContext): boolean {
  return can("runs:read") || can("runs:read-all");
}

/**
 * Ordered from the widest to the narrowest, which is also roughly the order a
 * conversation hits them: reach the API at all, run something, look at what
 * ran, find the files it produced, then the two integration acts people
 * confuse for each other, then scheduling.
 */
export const CHAT_CAPABILITIES: readonly ChatCapability[] = [
  {
    // The whole acting surface. Without it the assistant answers from its own
    // words and nothing else — which is the single most useful thing to know.
    id: "callApi",
    labelKey: "access.capability.callApi",
    held: invokes,
  },
  {
    // `run_and_wait`, the tool the assistant is told to prefer, refuses
    // WITHOUT a run-read permission before launching — it would otherwise
    // start a billed run whose status it cannot poll. The launch routes then
    // ask `agents:run` (`POST /api/agents/…/run`, `POST /api/runs/inline`).
    // A fire-and-forget `runAgent` through `invoke_operation` would still pass
    // without run-read, but the assistant could never report its result, so
    // this row does not count it as running an agent FOR the caller.
    id: "runAgents",
    labelKey: "access.capability.runAgents",
    held: (ctx) => invokes(ctx) && readsRuns(ctx) && ctx.can("agents:run"),
  },
  {
    // CREATING only. A new agent lands in the current space, where
    // `agents:write` is what the create route asks. Editing an EXISTING agent
    // is authorized by the package's HOME space (`requirePackageInOrg()` in
    // `apps/api/src/routes/packages.ts`), which for an agent shared from
    // elsewhere is not this one — so this grant proves nothing about it.
    id: "createAgents",
    labelKey: "access.capability.createAgents",
    held: (ctx) => invokes(ctx) && ctx.can("agents:write"),
  },
  {
    id: "readRuns",
    labelKey: "access.capability.readRuns",
    held: (ctx) => invokes(ctx) && readsRuns(ctx),
  },
  {
    // BROWSING, not reading: `list_files` needs no `mcp:invoke` but dispatches
    // `GET /api/files`, which `files:read` gates. Reading an `appfile://` the
    // caller attached goes through `read_file`, which applies the file ACL
    // and NOT this permission — so a "read your files" row keyed on it would
    // deny something the server allows.
    id: "browseFiles",
    labelKey: "access.capability.browseFiles",
    held: (ctx) => reachesMcp(ctx) && ctx.can("files:read"),
  },
  {
    // Connecting is personal; activating is per space
    // (`POST /api/spaces/:spaceId/packages`). The chat's own
    // system prompt has to explain that distinction when an
    // `integration_not_active` error lands — showing both rows is what lets a
    // user see, before that happens, which half they hold.
    id: "connectIntegrations",
    labelKey: "access.capability.connectIntegrations",
    held: (ctx) => invokes(ctx) && ctx.can("integrations:connect"),
  },
  {
    // NOT `can(PACKAGE_PERMISSIONS.integration.activate)`: in a personal space
    // the owner may activate without holding the grant, and a row saying
    // otherwise would contradict the route. One rule, `maySetPackageActive`,
    // shared with every other activation control in the SPA.
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

/** One capability, resolved for a caller. */
export interface ResolvedChatCapability extends ChatCapability {
  granted: boolean;
}

/**
 * Every capability with its verdict, in declaration order.
 *
 * `chat:write` gates the turn itself (`POST /api/chat`,
 * `packages/module-chat/src/routes.ts`): a caller holding only `chat:read`
 * — the `viewer` preset — can open past transcripts but never send the
 * message that would make the assistant act, so every row is refused for
 * them whatever else they hold.
 */
export function resolveChatCapabilities(ctx: ChatAccessContext): ResolvedChatCapability[] {
  const converses = ctx.can("chat:write");
  return CHAT_CAPABILITIES.map((capability) => ({
    ...capability,
    granted: converses && capability.held(ctx),
  }));
}
