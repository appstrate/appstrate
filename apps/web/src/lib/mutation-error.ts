// SPDX-License-Identifier: Apache-2.0

import { toast } from "sonner";
import { getErrorMessage } from "@appstrate/core/errors";
import i18n from "../i18n";
import { ApiError } from "../api/errors";

/**
 * Refusals whose English server `detail` is replaced by a translated sentence; the lock codes
 * interpolate the field named in `param`. From `pinned_connection_unavailable` on, the codes are
 * the resolver's per-integration `errors[]` items.
 */
const REFUSAL_ERROR_KEYS: Record<string, string> = {
  locked_input_field: "error.lockedInputField",
  locked_required_field_empty: "error.lockedRequiredFieldEmpty",
  draft_not_writable: "error.draftNotWritable",
  connection_label_taken: "error.connectionLabelTaken",
  connection_pinned: "error.connectionPinned",
  connection_owner_without_access: "error.connectionOwnerWithoutAccess",
  pinned_connection_unavailable: "error.pinnedConnectionUnavailable",
  override_connection_unavailable: "error.overrideConnectionUnavailable",
  needs_reconnection: "error.needsReconnection",
  must_choose_connection: "error.mustChooseConnection",
  not_connected: "error.notConnected",
  insufficient_scopes: "error.insufficientScopes",
  auth_key_mismatch: "error.authKeyMismatch",
  auth_serves_no_selected_tool: "error.authServesNoSelectedTool",
  auth_key_serves_no_selected_tool: "error.authKeyServesNoSelectedTool",
  override_outranked: "error.overrideOutranked",
};

export function refusalMessage(err: { code: string; param?: string }): string | null {
  const key = REFUSAL_ERROR_KEYS[err.code];
  if (!key) return null;
  // `param` is `<prefix>.<field>`; the field itself may contain dots, so only
  // the first segment is the prefix.
  const field = err.param?.slice(err.param.indexOf(".") + 1) || err.param || "";
  return i18n.t(key, { field, ns: "agents" });
}

export function onMutationError(err: Error) {
  // A run launch answers this 409 with its recovery modal, a schedule form inline, and a
  // surface with no picker with `toastScheduleConnectionChoice`.
  if (err instanceof ApiError && err.code === "missing_integration_connection") {
    return;
  }
  if (err instanceof ApiError) {
    const refusal = refusalMessage(err);
    if (refusal) {
      toast.error(refusal);
      return;
    }
  }
  toast.error(i18n.t("error.prefix", { message: getErrorMessage(err) }));
}

/**
 * A schedule write's `409 missing_integration_connection`, for a surface with no picker (the
 * detail page's enable toggle). Anything else is left to `onMutationError`.
 */
export function toastScheduleConnectionChoice(err: Error) {
  if (err instanceof ApiError && err.code === "missing_integration_connection") {
    toast.error(i18n.t("schedule.connectionChoiceRequired", { ns: "agents" }));
  }
}
