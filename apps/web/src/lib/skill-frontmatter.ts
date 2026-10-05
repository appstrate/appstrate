// SPDX-License-Identifier: Apache-2.0

/** SKILL.md frontmatter errors, client side — `checkSkillMarkdown` is the server's own checker. */

import { checkSkillMarkdown } from "@appstrate/afps-shared/companion-files";
import { ApiError } from "../api/errors";
import { SKILL_FRONTMATTER_ERROR_KEYS } from "./mutation-error";

/** The i18n key plus the checker's own sentence as `detail` (it names the exact fault). */
export function skillFrontmatterError(content: string): { key: string; detail: string } | null {
  const violation = checkSkillMarkdown(content);
  if (!violation) return null;
  return {
    key: SKILL_FRONTMATTER_ERROR_KEYS[violation.reason.toLowerCase()] ?? "editor.errorContent",
    detail: violation.message,
  };
}

/** The message for a failed skill write, or `null` to let the server's `detail` stand. */
export function translateSkillFrontmatterError(
  err: unknown,
  t: (key: string, options?: { detail: string }) => string,
): string | null {
  if (!(err instanceof ApiError)) return null;
  const errors: unknown = err.details;
  if (!Array.isArray(errors)) return null;
  const first = errors[0] as { code?: string; message?: string } | undefined;
  const key = first?.code ? SKILL_FRONTMATTER_ERROR_KEYS[first.code.toLowerCase()] : undefined;
  if (!key) return null;
  return t(key, { detail: first?.message ?? err.message });
}
