// SPDX-License-Identifier: Apache-2.0

import type {
  AgentIntegrationEntry,
  IntegrationAgentResolution,
  IntegrationManifestView,
} from "@appstrate/shared-types";
import { requiredScopesForAgent } from "@appstrate/core/integration";
import { pickDefaultAuth } from "./pick-default-auth";

/**
 * Whether the agent declares an actual usage for this integration. "Active" =
 * selected tools (MCP integrations) OR selected oauth scopes (apiCall
 * integrations, which expose no discrete tools) OR the `"*"` wildcard
 * (AFPS §4.4). An integration that is declared but inert (nothing selected) is
 * never spawned at runtime, so it never gates Run — callers filter on this
 * before deciding readiness.
 *
 * Single source of truth for the "is this integration in play?" question,
 * shared by the Connexions tab cards, the per-integration picker, and the
 * launch-button readiness badge.
 */
export function isIntegrationEntryActive(
  entry: Pick<AgentIntegrationEntry, "tools" | "scopes">,
): boolean {
  return entry.tools === "*" || (entry.tools?.length ?? 0) > 0 || (entry.scopes?.length ?? 0) > 0;
}

/**
 * Whether the run-kickoff gate (`validateAgentReadiness` → 412
 * `missing_integration_connection`) would reject this integration.
 *
 * Derived from the SAME server verdict the agent Connexions picker renders and
 * the MissingConnectionsModal recovers from: `IntegrationAgentResolution`,
 * built by `resolveAgentIntegrationPick` from the very `resolveConnectionsForRun`
 * cascade the runtime uses. Keeping the launch badge on this predicate means
 * the badge, the tab, and the 412 modal never disagree about what counts as
 * "not connected".
 *
 * Status → blocks-run mapping:
 *   - `none` ........... not connected (active integration, no candidate)
 *   - `must_choose` .... N>1 candidates, ambiguous pick
 *   - `needs_reconnection` connection flagged for re-consent
 *   - `stale` .......... pinned/override connection unavailable
 *   - `auto` / `pinned` / `admin_locked` resolve to a connection → OK, UNLESS
 *     `resolved_missing_scopes` is non-empty (insufficient_scopes upgrade).
 *
 * Caller passes only ACTIVE entries (see {@link isIntegrationEntryActive}) —
 * an inert integration resolving to `none` is not a gap.
 */
export function resolutionBlocksRun(resolution: IntegrationAgentResolution): boolean {
  if (resolution.resolved_missing_scopes.length > 0) return true;
  return (
    resolution.status === "none" ||
    resolution.status === "must_choose" ||
    resolution.status === "needs_reconnection" ||
    resolution.status === "stale"
  );
}

/** A connect / reconnect / upgrade CTA derived from the server resolution. */
export interface IntegrationConnectAction {
  authKey: string;
  scopes?: string[];
  intent: "connect" | "reconnect" | "upgrade";
  connectionId?: string;
}

/**
 * Map the server resolution → connect action. Single source of truth for the
 * connect/reconnect/upgrade CTA, used by the run-kickoff 412 recovery surface
 * (`MissingConnectionsModal`) to derive an affordance from the same verdict the
 * picker renders. Mirrors {@link resolutionBlocksRun}'s blocking states,
 * choosing the right intent + target:
 *
 *   - `resolved_missing_scopes` non-empty → `upgrade` the resolved connection
 *     (incremental consent for the missing scopes only).
 *   - `needs_reconnection` → `reconnect` the resolved connection.
 *   - `none` / `must_choose` / `stale` → `connect` a fresh connection on the
 *     default auth (preferring oauth2; mirrors the spawn resolver — the agent
 *     only needs ONE of the declared auths resolved).
 *   - `auto` / `pinned` / `admin_locked` with no missing scopes → null (OK).
 *
 * Connect/reconnect/upgrade all request the agent's inferred scopes — the
 * backend only adds manifest defaults for a plain connect, so the agent
 * surface forwards what THIS agent needs (the integration page connects at
 * defaults). Empty union (no tools/scopes picked) → omit, stay at defaults.
 */
export function resolveAction(
  resolution: IntegrationAgentResolution,
  manifest: IntegrationManifestView,
  agentTools: string[] | "*" | undefined,
  agentScopes: string[] | undefined,
): IntegrationConnectAction | null {
  const resolvedConnection =
    resolution.candidates.find((c) => c.id === resolution.resolved_connection_id) ?? null;

  // Under-scoped resolved connection → incremental-consent upgrade on it.
  if (resolution.resolved_missing_scopes.length > 0 && resolvedConnection) {
    return {
      authKey: resolvedConnection.auth_key,
      intent: "upgrade",
      connectionId: resolvedConnection.id,
      scopes: resolution.resolved_missing_scopes,
    };
  }

  // Resolved connection flagged for re-consent → reconnect it in place.
  if (resolution.status === "needs_reconnection" && resolvedConnection) {
    const scopes = requiredScopesForAgent({
      manifest,
      authKey: resolvedConnection.auth_key,
      agentTools,
      agentScopes,
    });
    return {
      authKey: resolvedConnection.auth_key,
      intent: "reconnect",
      connectionId: resolvedConnection.id,
      ...(scopes.length ? { scopes } : {}),
    };
  }

  // Any remaining blocking state — none / must_choose / stale, OR a
  // needs_reconnection / missing-scopes resolution whose target connection is
  // absent from `candidates` (so the upgrade/reconnect branches above didn't
  // fire) — falls back to a fresh connect on the default auth. Keying this off
  // the same predicate the run badge uses keeps the CTA in lockstep with
  // resolutionBlocksRun: the card never goes silent while the badge blocks.
  if (resolutionBlocksRun(resolution)) {
    const authKey = pickDefaultAuth(manifest.auths);
    if (!authKey) return null;
    const scopes = requiredScopesForAgent({ manifest, authKey, agentTools, agentScopes });
    return { authKey, intent: "connect", ...(scopes.length ? { scopes } : {}) };
  }

  // auto / pinned / admin_locked, fully scoped → connected, no action.
  return null;
}
