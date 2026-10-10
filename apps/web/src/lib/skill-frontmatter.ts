// SPDX-License-Identifier: Apache-2.0

/** SKILL.md frontmatter errors, client side — `checkSkillMarkdown` is the server's own checker. */

import { checkSkillMarkdown } from "@appstrate/afps-shared/companion-files";
import { SKILL_FRONTMATTER_ERROR_KEYS } from "./mutation-error";

/**
 * The i18n key naming the fault. The checker's own sentence is English (and a YAML parser's
 * text with it), so the screen says the rule in the reader's language and never quotes it.
 */
export function skillFrontmatterError(content: string): { key: string } | null {
  const violation = checkSkillMarkdown(content);
  if (!violation) return null;
  return {
    key: SKILL_FRONTMATTER_ERROR_KEYS[violation.reason.toLowerCase()] ?? "editor.errorContent",
  };
}
