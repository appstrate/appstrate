// SPDX-License-Identifier: Apache-2.0

import { toast } from "sonner";
import { getErrorMessage } from "@appstrate/core/errors";
import i18n from "../i18n";
import { ApiError } from "../api/errors";

/**
 * Refusals whose sentence is agent-domain copy other components reuse (`agents:error.*`); the
 * lock codes interpolate the field named in `param`. From `pinned_connection_unavailable` on,
 * the codes are the resolver's per-integration `errors[]` items. Every other code resolves by
 * convention — see `refusalMessage`.
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

/** What a refusal carries: a problem body, or one item of its `errors[]`. */
interface Refusal {
  code: string;
  param?: string;
  field?: string;
  message?: string;
}

/**
 * The translated sentence for a server refusal `code`, or `null` when it has none. A code is
 * translated by adding `apiError.<code>` to `locales/{fr,en}/common.json` — nothing to register
 * here; `test/api-error-codes.test.ts` fails on a code the API emits without one. Better Auth's
 * UPPER_SNAKE codes share the table, lower-cased.
 */
export function refusalMessage(err: Refusal): string | null {
  const code = err.code.toLowerCase();
  const agentsKey = REFUSAL_ERROR_KEYS[code];
  const key = agentsKey ?? `apiError.${code}`;
  const ns = agentsKey ? "agents" : "common";
  if (!i18n.exists(key, { ns })) return null;
  // `param` is `<prefix>.<field>`; the field itself may contain dots, so only
  // the first segment is the prefix.
  const field = err.field ?? (err.param?.slice(err.param.indexOf(".") + 1) || err.param || "");
  return i18n.t(key, { field, message: err.message ?? "", ns });
}

/** The first `errors[]` item of a `validation_failed`: its own code names the actual refusal. */
function firstFieldError(err: ApiError): Refusal | null {
  const first: unknown = Array.isArray(err.details) ? err.details[0] : undefined;
  if (typeof first !== "object" || first === null) return null;
  const { code, field, message } = first as Record<string, unknown>;
  if (typeof code !== "string") return null;
  return {
    code,
    field: typeof field === "string" ? field : undefined,
    message: typeof message === "string" ? message : undefined,
  };
}

/**
 * The sentence to show for any failure. A server refusal is named by its translated `code`,
 * never by its English `detail`; only a failure that carries no known code (network error,
 * a code from a module this SPA build has no copy for) falls back to the raw message.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const item = err.code === "validation_failed" ? firstFieldError(err) : null;
    const refusal = (item && refusalMessage(item)) ?? refusalMessage(err);
    if (refusal) return refusal;
  }
  return i18n.t("error.prefix", { message: getErrorMessage(err) });
}

export function onMutationError(err: Error) {
  // A run launch answers this 409 with its recovery modal, a schedule form inline, and a
  // surface with no picker with `toastScheduleConnectionChoice`.
  if (err instanceof ApiError && err.code === "missing_integration_connection") {
    return;
  }
  toast.error(errorMessage(err));
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
