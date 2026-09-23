// SPDX-License-Identifier: Apache-2.0

import { toast } from "sonner";
import { getErrorMessage } from "@appstrate/core/errors";
import i18n from "../i18n";
import { ApiError } from "../api/client";

/**
 * Refusals whose server sentence is replaced rather than prefixed. The raw
 * `detail` is English, so a French UI falling back to it tells the user
 * nothing they can act on.
 *
 * The two lock codes are about ONE named field and the server puts its name in
 * `param` (`input.<field>` / `locked_fields.<field>`) — hence the `field`
 * interpolation, which a code carrying no `param` simply leaves empty.
 * `draft_not_writable` is the launch refusal: the draft is the author's
 * working copy and runs only for whoever can write the package in its home
 * space, so the sentence has to say which version WILL run instead.
 */
const REFUSAL_ERROR_KEYS: Record<string, string> = {
  locked_input_field: "error.lockedInputField",
  locked_required_field_empty: "error.lockedRequiredFieldEmpty",
  draft_not_writable: "error.draftNotWritable",
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
  // Skip the generic toast for missing_integration_connection (412) —
  // the RunAgentButton renders MissingConnectionsModal off `runAgent.error`
  // for that case. Showing both a toast AND the modal is noisy and the
  // toast carries strictly less info than the modal.
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
