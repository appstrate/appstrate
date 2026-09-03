// SPDX-License-Identifier: Apache-2.0

/**
 * Reading a §3.3 violation the SERVER reported — code → message.
 *
 * Split from `skill-frontmatter.ts` for one reason: that module runs the real
 * checker, which pulls `@appstrate/afps-shared` and with it the `yaml` parser
 * (~100 kB). Only the skill EDITOR needs to check as you type. Every other
 * surface — the publish modal, the version-restore dialog — only ever
 * translates a code that came back on a 400, and must not drag a YAML parser
 * into its chunk to do it. Nothing here imports afps-shared.
 */

import { ApiError } from "../api/errors";

/**
 * i18n key per companion reason. Keys are literal dotted strings so the
 * extraction pass can see them.
 *
 * Exactly the five reasons `checkSkillMarkdown` returns — no
 * `SKILL_MISSING_SKILL_MD`: that one comes from `checkCompanionFiles`, which
 * asks whether the FILE exists in an archive, a question neither the editor
 * (whose content IS the file) nor the write-path 400s can ever raise here.
 *
 * Typed against the string reasons rather than importing
 * `CompanionViolationReason`, which would re-introduce the dependency this
 * split exists to remove. The map is exhaustive by test, not by type.
 */
const MESSAGE_KEY: Record<string, string> = {
  SKILL_INVALID_FRONTMATTER: "editor.errorSkillInvalidFrontmatter",
  SKILL_MISSING_FRONTMATTER_NAME: "editor.errorSkillFrontmatterName",
  SKILL_INVALID_FRONTMATTER_NAME: "editor.errorSkillInvalidName",
  SKILL_MISSING_FRONTMATTER_DESCRIPTION: "editor.errorSkillFrontmatterDescription",
  SKILL_INVALID_FRONTMATTER_DESCRIPTION: "editor.errorSkillDescriptionTooLong",
};

/** The i18n key for a companion reason, or `null` when it is not one of ours. */
export function skillFrontmatterMessageKey(reason: string): string | null {
  return MESSAGE_KEY[reason] ?? null;
}

/**
 * Same mapping, keyed by the machine-readable `code` the API puts on its
 * `validation_failed` field errors (the companion reason, lowercased).
 */
export function skillFrontmatterErrorKeyForApiCode(code: string): string | null {
  return skillFrontmatterMessageKey(code.toUpperCase());
}

/**
 * Turn a failed skill write into the message the author reads, or `null` to let
 * the server's own `detail` stand.
 *
 * Reads `ApiError.details` as the ARRAY it is: `toApiError` (`api/client.ts`)
 * assigns the problem body's `errors` to that field directly — it is not an
 * object with an `errors` key, and treating it as one silently matched nothing
 * and always fell through to the English `detail`.
 *
 * The server's own sentence is passed through as `detail`. Several of these
 * messages exist precisely to say "the exact fault is named below" — an
 * invalid-frontmatter code carries the YAML parser's error, which is the only
 * part that tells the author WHICH line to fix — so dropping it would leave a
 * translated string promising a detail that was never shown.
 */
export function translateSkillFrontmatterError(
  err: unknown,
  t: (key: string, options?: { detail: string }) => string,
): string | null {
  if (!(err instanceof ApiError)) return null;
  const errors: unknown = err.details;
  if (!Array.isArray(errors)) return null;
  const first = errors[0] as { code?: string; message?: string } | undefined;
  const key = first?.code ? skillFrontmatterErrorKeyForApiCode(first.code) : null;
  if (!key) return null;
  return t(key, { detail: first?.message ?? err.message });
}
