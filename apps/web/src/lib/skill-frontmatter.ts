// SPDX-License-Identifier: Apache-2.0

/** SKILL.md frontmatter errors, client side — `checkSkillMarkdown` is the server's own checker. */

import { checkSkillMarkdown } from "@appstrate/afps-shared/companion-files";
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
