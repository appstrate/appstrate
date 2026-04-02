# Custom Skill Example

Demonstrates how to create a minimal Appstrate skill that extends the Pi Coding Agent with custom tools.

## What is a Skill?

A skill is a package that adds capabilities to the AI agent during agent runs. Skills are defined by a `SKILL.md` file (with YAML frontmatter) and one or more TypeScript extension files. At runtime, skills are injected into the agent container at `.pi/skills/{id}/`.

## File Structure

```
custom-skill/
  SKILL.md       # Skill definition with YAML frontmatter
  skill.ts       # Extension implementing the tool
```

## How It Works

1. **`SKILL.md`** describes the skill's purpose in YAML frontmatter (`name`, `description`). The agent reads this file to understand what the skill does and when to invoke it.

2. **`skill.ts`** exports an extension factory compatible with the Pi Coding Agent SDK (`@mariozechner/pi-coding-agent`). The `execute` function receives tool call parameters and returns a result.

3. When a flow runs, the platform injects skill files into the agent container. The agent discovers available skills and can call their tools based on the flow prompt context.

## Packaging

To use this skill in Appstrate, package it as an AFPS ZIP file:

```
custom-skill-1.0.0.zip
  manifest.json    # AFPS manifest (type: "skill", name, version, description)
  SKILL.md
  skill.ts
```

The `manifest.json` follows the AFPS (Agent Flow Packaging Standard) format:

```json
{
  "name": "custom-skill",
  "version": "1.0.0",
  "type": "skill",
  "description": "A minimal example skill",
  "entrypoint": "skill.ts"
}
```

Import the ZIP from the dashboard (Flows > Import Package) or via the API.

## Further Reading

- See `system-packages/` in the Appstrate repo for real-world skill examples
- AFPS specification: `afps-spec/` in the workspace root
- Pi Coding Agent SDK: `@mariozechner/pi-coding-agent`
