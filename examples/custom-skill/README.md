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

   Both fields are **required** and validated on every path that WRITES a skill — editor create and save, publish, version restore, ZIP/bundle/GitHub/MCP import — where a violation is a `400`. Reading an already-published skill is not gated, so a skill published before this rule keeps loading; fix it by editing its draft and publishing again.

   The block is parsed with the [`yaml`](https://eemeli.org/yaml/) library at the same major the skill runtime uses, so anything the agent can parse Appstrate accepts, and anything YAML rejects (`description: a: b`, `name:x`, a duplicate key, a non-string value) Appstrate rejects too. Save the file **without a byte-order mark**: the runtime looks for a literal `---` at offset zero and reads no frontmatter behind a BOM.

   `name` follows the [Agent Skills specification](https://agentskills.io/specification) — 1-64 characters of lowercase `a-z`, `0-9` and `-`, no leading, trailing or consecutive hyphen — written **inline on one line**, and is the bare skill slug (`word-count`), not the scoped package id (`@acme/word-count`). `description` must be non-empty and at most 1024 characters; block scalars work:

   ```yaml
   description: |
     Counts the number of words in a given text.
     Use when the user asks for word statistics.
   ```

2. **`skill.ts`** exports an extension factory compatible with the Pi Coding Agent SDK (`@earendil-works/pi-coding-agent`). The `execute` function receives tool call parameters and returns a result.

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
- Pi Coding Agent SDK: `@earendil-works/pi-coding-agent`
