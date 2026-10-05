// SPDX-License-Identifier: Apache-2.0

import { toast } from "sonner";
import { getErrorMessage } from "@appstrate/core/errors";
import i18n from "../i18n";
import { ApiError } from "../api/errors";

/** SKILL.md frontmatter refusals; their sentences quote the checker's own `{{detail}}`. */
export const SKILL_FRONTMATTER_ERROR_KEYS: Record<string, string> = {
  skill_invalid_frontmatter: "editor.errorSkillInvalidFrontmatter",
  skill_missing_frontmatter_name: "editor.errorSkillFrontmatterName",
  skill_invalid_frontmatter_name: "editor.errorSkillInvalidName",
  skill_missing_frontmatter_description: "editor.errorSkillFrontmatterDescription",
  skill_invalid_frontmatter_description: "editor.errorSkillDescriptionTooLong",
};

/**
 * Refusals whose sentence is agent-domain copy other components reuse (`agents:*`); the lock
 * codes interpolate the field named in `param`. From `pinned_connection_unavailable` on, the
 * codes are the resolver's per-integration `errors[]` items. Every other code resolves by
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
  // Draft-tree refusals only the package editor can provoke: its sentences name the remedy.
  invalid_path: "files.errorInvalidPath",
  reserved_entry: "files.errorReserved",
  path_conflict: "files.errorConflictPath",
  ...SKILL_FRONTMATTER_ERROR_KEYS,
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
 * here. A sentence that cannot say everything the server said ends with its `{{message}}`.
 * Better Auth's and the importers' UPPER_SNAKE codes share the table, lower-cased.
 */
export function refusalMessage(err: Refusal): string | null {
  const code = err.code.toLowerCase();
  const message = err.message ?? "";
  const agentsKey = REFUSAL_ERROR_KEYS[code];
  if (agentsKey) {
    if (!i18n.exists(agentsKey, { ns: "agents" })) return null;
    // `param` is `<prefix>.<field>`; the field itself may contain dots, so only
    // the first segment is the prefix.
    const field = err.param?.slice(err.param.indexOf(".") + 1) || err.param || "";
    return i18n.t(agentsKey, { field, message, detail: message, ns: "agents" });
  }
  const key = `apiError.${code}`;
  if (!i18n.exists(key, { ns: "common" })) return null;
  // `input.` is the wire prefix of a launch parameter, not part of the name the user typed.
  // A code emitted both with and without a field has a second sentence, `<key>_nofield`, so
  // the first never renders an empty « ».
  const field = (err.field ?? err.param)?.replace(/^input\./, "");
  return i18n.t(key, { field, message, context: field ? undefined : "nofield", ns: "common" });
}

/** The `errors[]` items of a `validation_failed`: each one's own code names a refusal. */
function fieldErrors(err: ApiError): Refusal[] {
  const items: unknown = err.details;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return [];
    const { code, field, message } = item as Record<string, unknown>;
    if (typeof code !== "string") return [];
    return [
      {
        code,
        field: typeof field === "string" ? field : undefined,
        message: typeof message === "string" ? message : undefined,
      },
    ];
  });
}

/** The request member a refusal blames (`param`, or the first `errors[]` item's `field`). */
export function errorField(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  return err.param ?? fieldErrors(err)[0]?.field;
}

/** The translated sentence for a failure, or `null` when it carries no code this SPA knows. */
function translated(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const [first, ...others] = err.code === "validation_failed" ? fieldErrors(err) : [];
  if (!first) return refusalMessage(err);
  // An item code with no sentence keeps the server's own summary, count included.
  const sentence = refusalMessage(first);
  if (!sentence) return null;
  if (others.length === 0) return sentence;
  return `${sentence} ${i18n.t("error.moreErrors", { count: others.length, ns: "common" })}`;
}

/**
 * The sentence to show for any failure, in an inline slot (a form error, an error panel). A
 * server refusal is named by its translated `code`; a failure that carries no known code (a
 * network error, a code from a module this SPA build has no copy for) keeps its own message,
 * and one that says nothing at all gets the generic sentence rather than an empty slot.
 */
export function errorMessage(err: unknown): string {
  return translated(err) ?? (getErrorMessage(err) || i18n.t("error.generic"));
}

/**
 * The one format of an error toast: the translated refusal, or "Erreur : <message>" for a
 * failure nothing translates. `options` is Sonner's (a `description` under the sentence).
 */
export function toastError(err: unknown, options?: Parameters<typeof toast.error>[1]) {
  toast.error(translated(err) ?? i18n.t("error.prefix", { message: errorMessage(err) }), options);
}

/** A failed write, as a mutation's `onError` — and what the global mutation toast calls. */
export function onMutationError(err: Error) {
  // A run launch answers this 409 with its recovery modal, a schedule form inline, and a
  // surface with no picker with `toastScheduleConnectionChoice`.
  if (err instanceof ApiError && err.code === "missing_integration_connection") {
    return;
  }
  toastError(err);
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
