// SPDX-License-Identifier: Apache-2.0

import type { IntegrationAgentResolution } from "@appstrate/shared-types";

/**
 * What an empty picker trigger asks the actor for: a pick among several
 * (`must_choose_connection`), or — every other state — a connection. A broken
 * explicit set never reaches it: the picker names that set whole.
 */
type EmptyPickerPrompt = "choose" | "connect";

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
   * The soft org default's whole stored set while it is the layer in play —
   * bound, or failed on a member (unreachable, or on an auth serving no
   * selected tool) — else empty. The candidates alone would hide that member.
   */
  softDefaultIds: string[];
  /**
   * The set binds: connections were resolved and no error was raised. False
   * when there is no verdict at all (no manifest loaded — `source` and
   * `error_code` both null, nothing resolved): that is not "ready".
   *
   * NOTE: this classifies connection health, not run relevance. Whether an
   * integration BLOCKS the run (an inert optional one does not) is the server's
   * `run_blocking` flag on the same bulk readiness query.
   */
  resolved: boolean;
  emptyPickerPrompt: EmptyPickerPrompt;
}

/**
 * The one reading of a server verdict (`source` + `error_code`, the resolver's
 * own vocabulary) the picker, the 409 recovery modal and the agent's
 * integrations block share — so none of them maps the codes on its own.
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
    softDefaultIds: source === "org_default" ? resolution.org_default_connection_ids : [],
    resolved: code === null && resolution.resolved_connection_ids.length > 0,
    emptyPickerPrompt: code === "must_choose_connection" ? "choose" : "connect",
  };
}
