// SPDX-License-Identifier: Apache-2.0

import { toast } from "sonner";
import { getErrorMessage } from "@appstrate/core/errors";
import i18n from "../i18n";
import { ApiError } from "../api/client";

/**
 * Refusals whose English server `detail` is replaced by a translated sentence. The lock codes
 * interpolate the field named in `param`; `draft_not_writable` says which version will run instead;
 * `connection_label_taken` answers a rename, whose caller just typed the label.
 */
const REFUSAL_ERROR_KEYS: Record<string, string> = {
  locked_input_field: "error.lockedInputField",
  locked_required_field_empty: "error.lockedRequiredFieldEmpty",
  draft_not_writable: "error.draftNotWritable",
  connection_label_taken: "error.connectionLabelTaken",
};

function refusalMessage(err: ApiError): string | null {
  const key = REFUSAL_ERROR_KEYS[err.code];
  if (!key) return null;
  // `param` is `<prefix>.<field>`; the field itself may contain dots, so only
  // the first segment is the prefix.
  const field = err.param?.slice(err.param.indexOf(".") + 1) || err.param || "";
  return i18n.t(key, { field, ns: "agents" });
}

export function onMutationError(err: Error) {
  // Skip the generic toast for missing_integration_connection (409): a run
  // launch answers it with the recovery modal (`useRunLauncher`, the one way
  // to launch), which says strictly more; a schedule form marks it inline, and
  // a surface with no picker adds `toastScheduleConnectionChoice`.
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
 * A schedule write's `409 missing_integration_connection`, named for a surface
 * with no picker (the detail page's enable toggle). The form needs none: it
 * marks the refused integrations inline. Anything else is left to the hook's
 * `onMutationError`, which stays silent on this code.
 */
export function toastScheduleConnectionChoice(err: Error) {
  if (err instanceof ApiError && err.code === "missing_integration_connection") {
    toast.error(i18n.t("schedule.connectionChoiceRequired", { ns: "agents" }));
  }
}
