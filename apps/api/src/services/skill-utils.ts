/** Strip surrounding quotes from a YAML value. */
function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Extract metadata (name + description) from a SKILL.md YAML frontmatter block. */
export function extractSkillMeta(content: string): {
  name: string;
  description: string;
  warnings: string[];
} {
  const warnings: string[] = [];
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    warnings.push("Pas de frontmatter YAML detecte (bloc --- ... --- attendu)");
    return { name: "", description: "", warnings };
  }

  const fm = fmMatch[1]!;
  const nameMatch = fm.match(/name:\s*(.+)/);
  const descMatch = fm.match(/description:\s*(.+)/);

  const name = nameMatch ? stripQuotes(nameMatch[1]!) : "";
  const description = descMatch ? stripQuotes(descMatch[1]!) : "";

  if (!name) {
    warnings.push("Champ 'name' manquant dans le frontmatter YAML");
  }
  if (!description) {
    warnings.push("Champ 'description' manquant dans le frontmatter YAML");
  }

  return { name, description, warnings };
}
