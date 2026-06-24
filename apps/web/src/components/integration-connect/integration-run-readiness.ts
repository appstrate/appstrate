// SPDX-License-Identifier: Apache-2.0

import type { IntegrationAgentResolution } from "@appstrate/shared-types";

/**
 * Whether a connection verdict (`IntegrationAgentResolution`) represents a
 * "not usable" connection state — no connection, ambiguous pick, stale, or
 * insufficient scopes. Used for the management views (Connexions tab cards, 412
 * recovery modal) to render per-connection status.
 *
 * NOTE: this is NOT the run-blocking authority. Whether an integration blocks
 * the run (run semantics — inert optional integrations don't block, inert
 * required ones do) comes from the server's `run_blocking` flag on the bulk
 * connection-readiness query (`useIntegrationRunBlocking` /
 * `useAgentConnectionReadiness`). This predicate only classifies a verdict's
 * connection health, independent of run relevance.
 *
 * Status → not-usable mapping:
 *   - `none` ........... not connected (no candidate)
 *   - `must_choose` .... N>1 candidates, ambiguous pick
 *   - `needs_reconnection` connection flagged for re-consent
 *   - `stale` .......... pinned/override connection unavailable
 *   - `auto` / `pinned` / `admin_locked` resolve to a connection → OK, UNLESS
 *     `resolved_missing_scopes` is non-empty (insufficient_scopes upgrade).
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
