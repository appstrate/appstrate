/** Extract the description from a SKILL.md YAML frontmatter block. */
export function extractSkillDescription(content: string): string {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const descMatch = fmMatch[1]!.match(/description:\s*(.+)/);
    if (descMatch) return descMatch[1]!.trim();
  }
  return "";
}
