// SPDX-License-Identifier: Apache-2.0

import type { IntegrationAgentResolution } from "@appstrate/shared-types";

/**
 * What the picker's trigger asks for when nothing is bound. `reconfigure`: the agent's own
 * `auth_key` serves none of its selected tools — no pick or connection clears it.
 */
type EmptyPickerPrompt = "choose" | "connect" | "reconfigure";

interface ResolutionView {
  /** The locking set — the admin pin's (`[]` pins none), else an enforced org default's. */
  lockedConnectionIds: string[];
  /** Which of the two locks it — they are lifted in different places, so the badge names it. */
  lockedBy: "admin_pin" | "org_default" | null;
  /** Bound without anyone's pick: a soft org default or the actor's single own connection. */
  byDefault: boolean;
  /** The soft org default's whole stored set while in play, incl. members candidates hide. */
  softDefaultIds: string[];
  /** Connection health, not run relevance (the server's `run_blocking`). No verdict ⇒ false. */
  resolved: boolean;
  emptyPickerPrompt: EmptyPickerPrompt;
}

/** The one reading of a server verdict shared by the picker and the agent block. */
export function describeResolution(resolution: IntegrationAgentResolution): ResolutionView {
  const { source, error_code: code, admin_pinned_connection_ids: adminPin } = resolution;
  const lock =
    adminPin !== null
      ? { by: "admin_pin" as const, ids: adminPin }
      : resolution.org_default_enforced
        ? { by: "org_default" as const, ids: resolution.org_default_connection_ids }
        : null;
  return {
    lockedConnectionIds: lock?.ids ?? [],
    lockedBy: lock?.by ?? null,
    byDefault: source === "org_default" || source === "fallback_auto",
    softDefaultIds: source === "org_default" ? resolution.org_default_connection_ids : [],
    resolved: code === null && resolution.resolved_connection_ids.length > 0,
    emptyPickerPrompt:
      code === "must_choose_connection"
        ? "choose"
        : code === "auth_key_serves_no_selected_tool"
          ? "reconfigure"
          : "connect",
  };
}

type UnboundReason = "inactive" | "admin_none" | "member_none" | "shared_only" | "not_connected";

/**
 * Why the run starts without this integration, else `null`. Every such start carries a
 * `warning_code`; without one, an empty set is an inert integration the run never needed.
 */
export function unboundReason(entry: {
  run_blocking: boolean;
  resolution: Pick<
    IntegrationAgentResolution,
    | "error_code"
    | "warning_code"
    | "resolved_connection_ids"
    | "admin_pinned_connection_ids"
    | "member_pinned_connection_ids"
    | "candidates"
  >;
}): UnboundReason | null {
  const r = entry.resolution;
  if (
    entry.run_blocking ||
    r.error_code !== null ||
    r.warning_code === null ||
    r.resolved_connection_ids.length > 0
  ) {
    return null;
  }
  if (r.warning_code === "integration_not_active") return "inactive";
  if (r.admin_pinned_connection_ids?.length === 0) return "admin_none";
  if (r.member_pinned_connection_ids?.length === 0) return "member_none";
  return r.candidates.some((c) => !c.is_own) ? "shared_only" : "not_connected";
}

export const UNBOUND_LABEL_KEYS: Record<UnboundReason, string> = {
  inactive: "detail.integrationUnboundInactive",
  admin_none: "detail.integrationUnboundAdminNone",
  member_none: "detail.integrationUnboundMemberNone",
  shared_only: "detail.integrationUnboundSharedOnly",
  not_connected: "detail.integrationUnbound",
};
