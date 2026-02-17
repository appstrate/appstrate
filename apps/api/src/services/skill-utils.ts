/** Extract metadata (name + description) from a SKILL.md YAML frontmatter block. */
export function extractSkillMeta(content: string): { name: string; description: string } {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1]!;
    const nameMatch = fm.match(/name:\s*(.+)/);
    const descMatch = fm.match(/description:\s*(.+)/);
    return {
      name: nameMatch ? nameMatch[1]!.trim() : "",
      description: descMatch ? descMatch[1]!.trim() : "",
    };
  }
  return { name: "", description: "" };
}
