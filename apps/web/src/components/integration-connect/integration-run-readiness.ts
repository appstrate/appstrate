// SPDX-License-Identifier: Apache-2.0

import type { AgentIntegrationEntry, IntegrationAgentResolution } from "@appstrate/shared-types";

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
