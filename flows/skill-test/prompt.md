# Skill Discovery Test

Your task is simple: discover and report all the skills you have access to.

## Instructions

1. Look inside the `.claude/skills/` directory to find all available skills
2. For each skill found, read the `SKILL.md` file and extract:
   - The skill name
   - The skill description (from YAML frontmatter)
   - Whether it's a symlink and where it points to (to determine if it's a global or flow-local skill)
3. Report your findings

## Expected Output

Return a JSON result with the list of discovered skills:

```json
{
  "summary": "Found N skills available",
  "skills": [
    {
      "name": "skill-name",
      "description": "...",
      "source_path": "/workspace/skills/... or /workspace/flow/skills/..."
    }
  ]
}
```
