// SPDX-License-Identifier: Apache-2.0

import type { IntegrationAgentResolution } from "@appstrate/shared-types";

/**
 * What the actor must do before a run can use this integration — one per
 * resolver error family, so each surface words the precise cause:
 *
 *  - `connect`            — nothing to bind (`not_connected`), or nothing on the
 *                           auth the agent pins (`auth_key_mismatch`).
 *  - `choose`             — no implicit pick (`must_choose_connection`).
 *  - `reconnect`          — a bound connection died (`needs_reconnection`).
 *  - `upgrade`            — a bound connection lacks scopes (`insufficient_scopes`).
 *  - `replace_unavailable` — a pin or override names a connection that is gone or
 *                           unshared (`*_connection_unavailable`).
 *  - `remove_unserving`   — a bound connection's auth exposes none of the
 *                           selected tools (`auth_serves_no_selected_tool`).
 */
type ResolutionRemedy =
  "connect" | "choose" | "reconnect" | "upgrade" | "replace_unavailable" | "remove_unserving";

const REMEDY_BY_CODE: Record<
  NonNullable<IntegrationAgentResolution["error_code"]>,
  ResolutionRemedy
> = {
  not_connected: "connect",
  auth_key_mismatch: "connect",
  must_choose_connection: "choose",
  needs_reconnection: "reconnect",
  insufficient_scopes: "upgrade",
  pinned_connection_unavailable: "replace_unavailable",
  override_connection_unavailable: "replace_unavailable",
  auth_serves_no_selected_tool: "remove_unserving",
};

interface ResolutionView {
  /**
   * The set an admin force imposes — this agent's admin pin, else an enforced
   * org default — else empty. Read off the stored configuration, not the
   * verdict: a member is never offered a pick either would override.
   */
  lockedConnectionIds: string[];
  /** Bound without anyone's pick: a soft org default or the actor's single own connection. */
  byDefault: boolean;
  /**
   * `null` when the connection state is usable — or when there is no verdict
   * at all (no manifest loaded), which is the run gate's to report.
   *
   * NOTE: this classifies connection health, not run relevance. Whether an
   * integration BLOCKS the run (an inert optional one does not) is the server's
   * `run_blocking` flag on the same bulk readiness query.
   */
  remedy: ResolutionRemedy | null;
}

/**
 * The one reading of a server verdict (`source` + `error_code`, the resolver's
 * own vocabulary) every surface shares — the picker, the 409 recovery modal and
 * the Connexions tab — so none of them maps the codes on its own.
 */
export function describeResolution(resolution: IntegrationAgentResolution): ResolutionView {
  const { source, error_code: code } = resolution;
  return {
    lockedConnectionIds:
      resolution.admin_pinned_connection_ids.length > 0
        ? resolution.admin_pinned_connection_ids
        : resolution.org_default_enforced
          ? resolution.org_default_connection_ids
          : [],
    byDefault: source === "org_default" || source === "fallback_auto",
    remedy: code === null ? null : REMEDY_BY_CODE[code],
  };
}
