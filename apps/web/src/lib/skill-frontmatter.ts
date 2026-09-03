// SPDX-License-Identifier: Apache-2.0

/**
 * Client-side AFPS §3.3 SKILL.md gate for the skill editor.
 *
 * The RULE is not restated here: `checkSkillMarkdown`
 * (`@appstrate/afps-shared/companion-files`) is the same checker every server
 * write path runs, so the editor cannot drift into accepting a SKILL.md the
 * server refuses (or nagging about one it accepts).
 *
 * EDITOR ONLY. This module pulls the `yaml` parser (~100 kB) through
 * afps-shared; surfaces that merely translate a code the server already
 * returned import `skill-frontmatter-messages.ts` instead.
 */

import { checkSkillMarkdown } from "@appstrate/afps-shared/companion-files";
import { skillFrontmatterMessageKey } from "./skill-frontmatter-messages";

/**
 * Run the shared companion check over an in-editor SKILL.md. Returns the i18n
 * key of the message to show plus the checker's own sentence as `detail`, or
 * `null` when it conforms.
 */
export function skillFrontmatterError(content: string): { key: string; detail: string } | null {
  const violation = checkSkillMarkdown(content);
  if (!violation) return null;
  return {
    key: skillFrontmatterMessageKey(violation.reason) ?? "editor.errorContent",
    // The checker's message names the exact fault — which YAML line, which
    // character, which bound. The translated strings promise it.
    detail: violation.message,
  };
}
