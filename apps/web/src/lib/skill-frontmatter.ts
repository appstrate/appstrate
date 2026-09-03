// SPDX-License-Identifier: Apache-2.0

/**
 * SKILL.md frontmatter errors, client side.
 *
 * The RULE is not restated here: `checkSkillMarkdown`
 * (`@appstrate/afps-shared/companion-files`) is the same checker every server
 * write path runs, so the editor cannot drift into accepting a SKILL.md the
 * server refuses (or nagging about one it accepts).
 */

import { checkSkillMarkdown } from "@appstrate/afps-shared/companion-files";
import { ApiError } from "../api/errors";

/**
 * i18n key per companion reason. Keys are literal dotted strings so the
 * extraction pass can see them. No `SKILL_MISSING_SKILL_MD`: that one asks
 * whether the FILE exists in an archive, which neither the editor (whose
 * content IS the file) nor a write-path 400 can raise here.
 */
const MESSAGE_KEY: Record<string, string> = {
  SKILL_INVALID_FRONTMATTER: "editor.errorSkillInvalidFrontmatter",
  SKILL_MISSING_FRONTMATTER_NAME: "editor.errorSkillFrontmatterName",
  SKILL_INVALID_FRONTMATTER_NAME: "editor.errorSkillInvalidName",
  SKILL_MISSING_FRONTMATTER_DESCRIPTION: "editor.errorSkillFrontmatterDescription",
  SKILL_INVALID_FRONTMATTER_DESCRIPTION: "editor.errorSkillDescriptionTooLong",
};

/**
 * Run the shared companion check over an in-editor SKILL.md. Returns the i18n
 * key of the message to show plus the checker's own sentence as `detail` —
 * which names the offending line or bound, and which the translated strings
 * promise — or `null` when it conforms.
 */
export function skillFrontmatterError(content: string): { key: string; detail: string } | null {
  const violation = checkSkillMarkdown(content);
  if (!violation) return null;
  return {
    key: MESSAGE_KEY[violation.reason] ?? "editor.errorContent",
    detail: violation.message,
  };
}

/**
 * Turn a failed skill write into the message the author reads, or `null` to let
 * the server's own `detail` stand.
 *
 * `ApiError.details` IS the problem body's `errors` array (`toApiError`,
 * `api/client.ts`) — not an object with an `errors` key.
 */
export function translateSkillFrontmatterError(
  err: unknown,
  t: (key: string, options?: { detail: string }) => string,
): string | null {
  if (!(err instanceof ApiError)) return null;
  const errors: unknown = err.details;
  if (!Array.isArray(errors)) return null;
  const first = errors[0] as { code?: string; message?: string } | undefined;
  const key = first?.code ? MESSAGE_KEY[first.code.toUpperCase()] : undefined;
  if (!key) return null;
  return t(key, { detail: first?.message ?? err.message });
}
