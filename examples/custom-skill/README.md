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

3. When an agent runs, the platform injects skill files into the agent container. The agent discovers available skills and can call their tools based on the agent prompt context.

## Packaging

To use this skill in Appstrate, package it as an AFPS archive. The canonical
extension is `.afps` (that is what everything in `system-packages/` uses); the
import routes also accept a plain `.zip` with identical contents.

```
custom-skill-1.0.0.afps      # a ZIP archive under the hood
  manifest.json              # AFPS manifest
  SKILL.md
  skill.ts
```

The `manifest.json` follows the AFPS (Agent Format Packaging Standard) format:

```json
{
  "name": "@acme/custom-skill",
  "version": "1.0.0",
  "type": "skill",
  "schema_version": "0.1",
  "display_name": "Custom Skill",
  "description": "A minimal example skill",
  "license": "Apache-2.0"
}
```

Two things this example gets asked about a lot:

- **`name` MUST be scoped** — `@scope/name`, matching
  `/^@[a-z0-9]([a-z0-9-]*[a-z0-9])?\/[a-z0-9]([a-z0-9-]*[a-z0-9])?$/`. A bare
  `"custom-skill"` is rejected at validation time with
  `Must follow @scope/name format`. Use your own scope, not `@appstrate`
  (reserved for system packages).
- **There is no `entrypoint` field.** A skill's contract is `SKILL.md` plus the
  files shipped alongside it; the manifest carries metadata only. Unknown keys
  are tolerated by the loose AFPS object schema, so an `entrypoint` would be
  silently ignored rather than honoured — which is worse than an error.

`schema_version` is optional for skills in the AFPS schema, but every real
package declares it and pinning it protects you from a future major bump —
include it.

Validate before publishing:

```sh
bunx afps inspect custom-skill-1.0.0.afps
```

Import from the dashboard (Agents > Import Package) or via the API.

## Further Reading

- Real skill/mcp-server/integration manifests: `scripts/system-packages/*/manifest.json`
- AFPS specification: <https://github.com/appstrate/afps-spec/blob/main/spec.md>
- Manifest validation source of truth: `packages/core/src/validation.ts`
- Pi Coding Agent SDK: `@mariozechner/pi-coding-agent`
