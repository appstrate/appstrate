// SPDX-License-Identifier: Apache-2.0

import { toast } from "sonner";
import { getErrorMessage } from "@appstrate/core/errors";
import type {
  INTEGRATION_MANIFEST_FAILURE_CODES,
  MissingIntegrationConnectionCode,
} from "@appstrate/core/integration";
import i18n from "../i18n";
import { ApiError } from "../api/errors";
import { PACKAGE_PATH_ERROR_KEYS } from "./package-files";

/** SKILL.md frontmatter refusals; each key is one rule, said in the reader's language. */
export const SKILL_FRONTMATTER_ERROR_KEYS: Record<string, string> = {
  skill_invalid_frontmatter: "editor.errorSkillInvalidFrontmatter",
  skill_missing_frontmatter_name: "editor.errorSkillFrontmatterName",
  skill_invalid_frontmatter_name: "editor.errorSkillInvalidName",
  skill_missing_frontmatter_description: "editor.errorSkillFrontmatterDescription",
  skill_invalid_frontmatter_description: "editor.errorSkillDescriptionTooLong",
};

/** Item codes whose sentence is `common:apiError.<code>`, or the server's own message. */
type CommonSentenceCode =
  | "integration_not_active"
  | (typeof INTEGRATION_MANIFEST_FAILURE_CODES)[number]
  | "remote_binds_one_connection";

/** Every other `missing_integration_connection` code, and a 400's `required_integration_unbound`. */
const RESOLUTION_ERROR_KEYS = {
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
  required_integration_unbound: "error.requiredIntegrationUnbound",
} as const satisfies Record<Exclude<MissingIntegrationConnectionCode, CommonSentenceCode>, string>;

/**
 * Refusals whose sentence is `agents:*` copy other components reuse; the lock codes interpolate
 * the field named in `param`. Every other code resolves to `common:apiError.<code>`.
 */
export const REFUSAL_ERROR_KEYS: Record<string, string> = {
  locked_input_field: "error.lockedInputField",
  locked_required_field_empty: "error.lockedRequiredFieldEmpty",
  draft_not_writable: "error.draftNotWritable",
  connection_label_taken: "error.connectionLabelTaken",
  connection_pinned: "error.connectionPinned",
  connection_owner_without_access: "error.connectionOwnerWithoutAccess",
  end_user_connection_not_shareable: "error.endUserConnectionNotShareable",
  ...RESOLUTION_ERROR_KEYS,
  ...PACKAGE_PATH_ERROR_KEYS,
  ...SKILL_FRONTMATTER_ERROR_KEYS,
};

/** Generic refusals made precise by the member they blame: `<code>:<param>` → `agents` key. */
const PARAM_REFUSAL_KEYS: Record<string, string> = {
  // An override key the launched version does not declare.
  "invalid_request:connection_overrides": "error.connectionOverridesRefused",
  // The only rule on the whole `runtime_tools` member: an output schema needs the `output` tool.
  "invalid_manifest:manifest.runtime_tools": "error.outputToolRequired",
};

/** What a refusal carries: a problem body, or one item of its `errors[]`. */
interface Refusal {
  code: string;
  param?: string;
  field?: string;
  message?: string;
}

/**
 * The translated sentence for a server refusal `code`, or `null` when it has none. Better
 * Auth's and the importers' UPPER_SNAKE codes share the table, lower-cased.
 */
export function refusalMessage(err: Refusal): string | null {
  const code = err.code.toLowerCase();
  const message = err.message ?? "";
  const paramKey = PARAM_REFUSAL_KEYS[`${code}:${err.param ?? err.field}`];
  if (paramKey) return i18n.t(paramKey, { ns: "agents" });
  const agentsKey = REFUSAL_ERROR_KEYS[code];
  if (agentsKey) {
    // `param` is `<prefix>.<field>`; the field itself may contain dots, so only
    // the first segment is the prefix.
    const field = err.param?.slice(err.param.indexOf(".") + 1) || err.param || "";
    return i18n.t(agentsKey, { field, message, detail: message, ns: "agents" });
  }
  const key = `apiError.${code}`;
  if (!i18n.exists(key, { ns: "common" })) return null;
  // `input.` is a launch parameter's wire prefix. `<key>_nofield` is the sentence of a code
  // also emitted without a field, so the first never renders an empty « ».
  const field = (err.field ?? err.param)?.replace(/^input\./, "");
  return i18n.t(key, { field, message, context: field ? undefined : "nofield", ns: "common" });
}

/** The `errors[]` items of a `validation_failed`: each one's own code names a refusal. */
function fieldErrors(err: ApiError): Refusal[] {
  return (err.errors ?? []).flatMap((item: unknown) => {
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

/** The `errors[]` items of a `validation_failed` refusal; none for any other failure. */
export function validationFieldErrors(err: unknown): Refusal[] {
  return err instanceof ApiError && err.code === "validation_failed" ? fieldErrors(err) : [];
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

/** What a failure says: its translated refusal, else its own message, else `null`. */
export function errorDetail(err: unknown): string | null {
  if (err === null || err === undefined) return null;
  return translated(err) ?? (getErrorMessage(err) || null);
}

/** The sentence for an inline slot (a form error): never empty. */
export function errorMessage(err: unknown): string {
  return errorDetail(err) ?? i18n.t("error.generic");
}

/** The one toast format: the translated refusal, or "Erreur : <message>" when nothing translates. */
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
