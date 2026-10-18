// SPDX-License-Identifier: Apache-2.0

import { toast } from "sonner";
import { getErrorMessage } from "@appstrate/core/errors";
import type { CompanionViolationReason } from "@appstrate/afps-shared/companion-files";
import type {
  OverrideRefusalCode,
  INTEGRATION_MANIFEST_FAILURE_CODES,
  MissingIntegrationConnectionCode,
} from "@appstrate/core/integration";
import i18n from "../i18n";
import { ApiError } from "../api/errors";
import { PACKAGE_PATH_ERROR_KEYS } from "./package-files";

/** SKILL.md frontmatter refusals; each key is one rule, said in the reader's language. */
export const SKILL_FRONTMATTER_ERROR_KEYS = {
  skill_invalid_frontmatter: "editor.errorSkillInvalidFrontmatter",
  skill_missing_frontmatter_name: "editor.errorSkillFrontmatterName",
  skill_invalid_frontmatter_name: "editor.errorSkillInvalidName",
  skill_missing_frontmatter_description: "editor.errorSkillFrontmatterDescription",
  skill_invalid_frontmatter_description: "editor.errorSkillDescriptionTooLong",
} as const satisfies Partial<Record<Lowercase<CompanionViolationReason>, string>>;

/** Where the validator stopped, in the reader's language (« (ligne 3, colonne 14) » or ""), from the server's 1-based `line`/`column`. */
export function filePosition(err: { line?: number; column?: number }): string {
  if (err.line === undefined || err.column === undefined) return "";
  return i18n.t("editor.errorSkillYamlPosition", {
    line: err.line,
    column: err.column,
    ns: "agents",
  });
}

/** Item codes whose sentence is `common:apiError.<code>`, or the server's own message. */
type CommonSentenceCode =
  | "integration_not_active"
  | (typeof INTEGRATION_MANIFEST_FAILURE_CODES)[number]
  | "remote_binds_one_connection";

/** Every other `missing_integration_connection` code, and the 400 items of a refused override key. */
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
  connection_set_too_large: "error.connectionSetTooLarge",
  required_integration_unbound: "error.requiredIntegrationUnbound",
  undeclared_connection_override: "error.connectionOverridesRefused",
  undeclared_dependency_override: "error.dependencyOverridesRefused",
} as const satisfies Record<
  Exclude<MissingIntegrationConnectionCode, CommonSentenceCode> | OverrideRefusalCode,
  string
>;

/** Refusals whose sentence is `agents:*` copy reused elsewhere; every other code resolves to `common:apiError.<code>`. */
export const REFUSAL_ERROR_KEYS = {
  locked_input_field: "error.lockedInputField",
  locked_required_field_empty: "error.lockedRequiredFieldEmpty",
  draft_not_writable: "error.draftNotWritable",
  connection_label_taken: "error.connectionLabelTaken",
  output_tool_required: "error.outputToolRequired",
  connection_pinned: "error.connectionPinned",
  connection_owner_without_access: "error.connectionOwnerWithoutAccess",
  end_user_connection_not_shareable: "error.endUserConnectionNotShareable",
  ...RESOLUTION_ERROR_KEYS,
  ...PACKAGE_PATH_ERROR_KEYS,
  ...SKILL_FRONTMATTER_ERROR_KEYS,
} as const;

export function sentenceKey(keys: Readonly<Record<string, string>>, code: string) {
  return Object.prototype.hasOwnProperty.call(keys, code) ? keys[code] : undefined;
}

/** A problem body, or one item of its `errors[]`. */
interface Refusal {
  code: string;
  param?: string;
  field?: string;
  message?: string;
  /** 1-based position in the offending file. */
  line?: number;
  column?: number;
}

/** The translated sentence for a refusal `code`, or `null`. Better Auth's and the importers' UPPER_SNAKE codes share the table, lower-cased. */
export function refusalMessage(err: Refusal): string | null {
  const code = err.code.toLowerCase();
  const message = err.message ?? "";
  const agentsKey = sentenceKey(REFUSAL_ERROR_KEYS, code);
  if (agentsKey) {
    // `param` is `<prefix>.<field>`; the field may contain dots, only the first segment is the prefix.
    const field = err.param?.slice(err.param.indexOf(".") + 1) || err.param || "";
    const position = filePosition(err);
    return i18n.t(agentsKey, { field, message, detail: message, position, ns: "agents" });
  }
  const key = `apiError.${code}`;
  if (!i18n.exists(key, { ns: "common" })) return null;
  // `input.` is a launch parameter's wire prefix; `<key>_nofield` is for a code also emitted without a field.
  const field = (err.field ?? err.param)?.replace(/^input\./, "");
  return i18n.t(key, { field, message, context: field ? undefined : "nofield", ns: "common" });
}

function fieldErrors(err: ApiError): Refusal[] {
  return (err.errors ?? []).flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return [];
    const { code, field, message, line, column } = item as Record<string, unknown>;
    if (typeof code !== "string") return [];
    return [
      {
        code,
        field: typeof field === "string" ? field : undefined,
        message: typeof message === "string" ? message : undefined,
        ...(typeof line === "number" && typeof column === "number" ? { line, column } : {}),
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

export function errorMessage(err: unknown): string {
  return errorDetail(err) ?? i18n.t("error.generic");
}

/** The one toast format: the translated refusal, or "Erreur : <message>" when nothing translates. */
export function toastError(err: unknown, options?: Parameters<typeof toast.error>[1]) {
  toast.error(translated(err) ?? i18n.t("error.prefix", { message: errorMessage(err) }), options);
}

/** A failed write, as a mutation's `onError` — and what the global mutation toast calls. */
export function onMutationError(err: Error) {
  // Answered elsewhere: the run launch's recovery modal, a schedule form inline, or `toastScheduleConnectionChoice`.
  if (err instanceof ApiError && err.code === "missing_integration_connection") {
    return;
  }
  toastError(err);
}

/** A schedule write's `409 missing_integration_connection` (the enable toggle has no picker; the settings' Save leads to Connexions with `action`); anything else is left to `onMutationError`. */
export function toastScheduleConnectionChoice(
  err: Error,
  action?: { label: string; onClick: () => void },
) {
  if (err instanceof ApiError && err.code === "missing_integration_connection") {
    toast.error(i18n.t("schedule.connectionChoiceRequired", { ns: "agents" }), { action });
  }
}
