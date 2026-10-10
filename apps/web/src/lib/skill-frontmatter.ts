// SPDX-License-Identifier: Apache-2.0

/** SKILL.md frontmatter errors, client side — `checkSkillMarkdown` is the server's own checker. */

import { checkSkillMarkdown } from "@appstrate/afps-shared/companion-files";
import { SKILL_FRONTMATTER_ERROR_KEYS, yamlPosition } from "./mutation-error";

/**
 * The i18n key naming the fault, with the `position` its sentence may hold. The checker's own
 * sentence is English (and a YAML parser's text with it), so the screen says the rule in the
 * reader's language and never quotes it; only the YAML error's line and column are carried over.
 */
export function skillFrontmatterError(
  content: string,
): { key: string; params: { position: string } } | null {
  const violation = checkSkillMarkdown(content);
  if (!violation) return null;
  const reason = violation.reason.toLowerCase();
  return {
    key: SKILL_FRONTMATTER_ERROR_KEYS[reason] ?? "editor.errorContent",
    params: {
      position: reason === "skill_invalid_frontmatter" ? yamlPosition(violation.message) : "",
    },
  };
}
