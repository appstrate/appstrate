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
 *   - `duplicate_label`  the bound set shares a label, so it is unaddressable
 *   - `needs_reconnection` connection flagged for re-consent
 *   - `stale` .......... pinned/override connection unusable, or the agent's
 *                        `auth_key` serves none of its selected tools
 *   - `auto` / `pinned` / `admin_locked` resolve to a connection → OK, UNLESS
 *     `resolved_missing_scopes` is non-empty (insufficient_scopes upgrade).
 */
export function resolutionBlocksRun(resolution: IntegrationAgentResolution): boolean {
  if (resolution.resolved_missing_scopes.length > 0) return true;
  return (
    resolution.status === "none" ||
    resolution.status === "must_choose" ||
    resolution.status === "duplicate_label" ||
    resolution.status === "needs_reconnection" ||
    resolution.status === "stale"
  );
}

/** Codes no connection pick can fix — the package-level verdicts and the agent's own `auth_key` misfit: a message, no picker. */
export function isStructuralCode(code: string): boolean {
  return (
    code === "integration_not_active" ||
    code === "integration_not_found" ||
    code === "integration_wrong_type" ||
    code === "integration_invalid_manifest" ||
    code === "pinned_auth_serves_no_selected_tool"
  );
}
