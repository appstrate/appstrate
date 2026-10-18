// SPDX-License-Identifier: Apache-2.0

/** A SKILL.md without its frontmatter (as markdown its closing `---` makes a heading); delimited as `parseSkillFrontmatter` reads it. */
export function skillBody(content: string): string {
  const normalized = content.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---")) return content;
  const close = normalized.indexOf("\n---", 3);
  if (close === -1) return content;
  const lineEnd = normalized.indexOf("\n", close + 4);
  return lineEnd === -1 ? "" : normalized.slice(lineEnd + 1);
}
