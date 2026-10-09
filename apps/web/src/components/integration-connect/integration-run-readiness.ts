// SPDX-License-Identifier: Apache-2.0

import type { ConnectionResolutionWarningCode } from "@appstrate/core/integration";
import type { components } from "../../api/schema";
import i18n from "../../i18n";
import { noneChosenBy } from "../../lib/launch-warnings";

type IntegrationAgentResolution = components["schemas"]["IntegrationAgentResolution"];

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
  const orgDefault = resolution.org_default_connection_ids ?? [];
  const lock =
    adminPin !== null
      ? { by: "admin_pin" as const, ids: adminPin }
      : resolution.org_default_enforced
        ? { by: "org_default" as const, ids: orgDefault }
        : null;
  return {
    lockedConnectionIds: lock?.ids ?? [],
    lockedBy: lock?.by ?? null,
    byDefault: source === "org_default" || source === "fallback_auto",
    softDefaultIds: source === "org_default" ? orgDefault : [],
    resolved: code === null && resolution.resolved_connection_ids.length > 0,
    emptyPickerPrompt:
      code === "must_choose_connection" || resolution.warning?.code === "must_choose_connection"
        ? "choose"
        : code === "auth_key_serves_no_selected_tool"
          ? "reconfigure"
          : "connect",
  };
}

export const UNBOUND_LABEL_KEYS = {
  not_connected: "detail.integrationUnbound",
  must_choose_connection: "detail.integrationUnboundSharedOnly",
  auth_key_mismatch: "detail.integrationUnboundOtherAuth",
  integration_not_active: "detail.integrationUnboundInactive",
  integration_unbound: "detail.integrationUnboundNone",
} as const satisfies Record<ConnectionResolutionWarningCode, string>;

/** Why the run starts without this integration — its launch warning — else `null`. */
export function unboundLabel(warning: IntegrationAgentResolution["warning"]): string | null {
  if (!warning) return null;
  const by = warning.code === "integration_unbound" ? noneChosenBy(warning.source) : null;
  return by
    ? i18n.t("detail.integrationUnboundNoneBy", { ns: "agents", by })
    : i18n.t(UNBOUND_LABEL_KEYS[warning.code], { ns: "agents" });
}

/** Who chose no connection for an integration the agent requires — which refuses the run — else `null`. */
export function requiredNoneLabel(
  resolution: Pick<IntegrationAgentResolution, "error_code" | "source">,
): string | null {
  if (resolution.error_code !== "required_integration_unbound") return null;
  const by = noneChosenBy(resolution.source);
  return by
    ? i18n.t("detail.integrationRequiredNoneBy", { ns: "agents", by })
    : i18n.t("detail.integrationRequiredNone", { ns: "agents" });
}
