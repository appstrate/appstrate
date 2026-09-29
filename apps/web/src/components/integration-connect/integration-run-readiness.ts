// SPDX-License-Identifier: Apache-2.0

import type { IntegrationAgentResolution } from "@appstrate/shared-types";

/** A broken explicit set never reaches an empty trigger: the picker names that set whole. */
type EmptyPickerPrompt = "choose" | "connect";

interface ResolutionView {
  /** The admin pin, else an enforced org default — read off the stored configuration. */
  lockedConnectionIds: string[];
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
