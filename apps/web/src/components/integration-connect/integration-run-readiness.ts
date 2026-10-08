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

/** The one reading of a server verdict shared by the picker, the 409 modal and the agent block. */
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

/**
 * What a run does with one declared integration: refuses to start (`blocked`), binds a set
 * (`bound`), or starts without it (`unbound` — a non-required integration with nothing to bind
 * or pinned to none, whose verdict carries no error; or an inert one, whose does not block).
 */
export type IntegrationRunState = "bound" | "unbound" | "blocked";

export function integrationRunState(entry: {
  run_blocking: boolean;
  resolution: Pick<IntegrationAgentResolution, "resolved_connection_ids">;
}): IntegrationRunState {
  if (entry.run_blocking) return "blocked";
  return entry.resolution.resolved_connection_ids.length === 0 ? "unbound" : "bound";
}
