// SPDX-License-Identifier: Apache-2.0

/** SKILL.md frontmatter errors, client side — `checkSkillMarkdown` is the server's own checker. */

import { checkSkillMarkdown } from "@appstrate/afps-shared/companion-files";
import { SKILL_FRONTMATTER_ERROR_KEYS, filePosition, sentenceKey } from "./mutation-error";

/**
 * The i18n key naming the fault. The checker's sentence is English, so the screen
 * says the rule in the reader's language; only the YAML error's position is carried over.
 */
export function skillFrontmatterError(
  content: string,
): { key: string; params: { position: string } } | null {
  const violation = checkSkillMarkdown(content);
  if (!violation) return null;
  const reason = violation.reason.toLowerCase();
  return {
    key: sentenceKey(SKILL_FRONTMATTER_ERROR_KEYS, reason) ?? "editor.errorContent",
    params: {
      position: violation.position ? filePosition(violation.position) : "",
    },
  };
}

/** A SKILL.md without its frontmatter (as markdown its closing `---` makes a heading); delimited as `parseSkillFrontmatter` reads it. */
export function skillBody(content: string): string {
  const normalized = content.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---")) return content;
  const close = normalized.indexOf("\n---", 3);
  if (close === -1) return content;
  const lineEnd = normalized.indexOf("\n", close + 4);
  return lineEnd === -1 ? "" : normalized.slice(lineEnd + 1);
}
