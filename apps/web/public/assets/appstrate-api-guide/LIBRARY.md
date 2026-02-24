# Library: Skills & Extensions

The library contains reusable components that flows can reference.

## Skills

Skills are Markdown instruction files that guide the agent's behavior. They are injected into the execution container at `.pi/skills/{skill-id}/SKILL.md`.

### Skill Format

A SKILL.md file with YAML frontmatter:

```markdown
---
name: my-skill-name
description: What this skill does and when to use it.
---

# Skill Title

## When to Use

- Scenario 1
- Scenario 2

## Instructions

1. Step one
2. Step two

## Examples

...
```

### List Skills

```
GET /api/library/skills
Authorization: Bearer ask_...
```

Returns built-in + org skills with `id`, `name`, `description`, `source`, `usedByFlows` count.

### Create a Skill

**First check if the skill ID already exists** via `GET /api/library/skills`:

```
POST /api/library/skills
Authorization: Bearer ask_...
Content-Type: application/json

{
  "id": "my-skill",
  "content": "---\nname: my-skill\ndescription: Does something useful\n---\n\n# My Skill\n\n...",
  "name": "My Skill",
  "description": "Does something useful"
}
```

The `name` and `description` are auto-extracted from YAML frontmatter if omitted.

### Get Skill Detail

```
GET /api/library/skills/{skillId}
Authorization: Bearer ask_...
```

Returns full content, metadata, and list of flows referencing this skill.

### Update a Skill

```
PUT /api/library/skills/{skillId}
Authorization: Bearer ask_...
Content-Type: application/json

{ "content": "---\nname: updated-skill\n...", "name": "Updated", "description": "New desc" }
```

Built-in skills cannot be modified (403).

### Delete a Skill

```
DELETE /api/library/skills/{skillId}
Authorization: Bearer ask_...
```

Returns 409 if still referenced by flows. **Check which flows reference it first** via `GET /api/library/skills/{skillId}` (includes `flows` field).

## Extensions

Extensions are TypeScript files that add tools to the Pi agent. They follow the ExtensionFactory pattern.

### Extension Format

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "my_tool",
    description: "What the tool does",
    parameters: {
      type: "object",
      properties: {
        input: { type: "string", description: "Tool input" },
      },
      required: ["input"],
    },
    async execute(_toolCallId, params, _signal) {
      // params.input contains the value
      const result = `Processed: ${params.input}`;
      return { content: [{ type: "text" as const, text: result }] };
    },
  });
}
```

**Critical details:**

- Import from `@mariozechner/pi-coding-agent` (NOT `pi-agent`)
- `execute` signature: `(_toolCallId, params, signal)` — params is the **second** argument
- Return type: `{ content: [{ type: "text", text: "..." }] }`
- Parameters: Plain JSON Schema objects

### Extension CRUD

Same pattern as skills:

```
GET    /api/library/extensions              # List all
POST   /api/library/extensions              # Create (id + content required)
GET    /api/library/extensions/{extensionId} # Get detail with source code
PUT    /api/library/extensions/{extensionId} # Update
DELETE /api/library/extensions/{extensionId} # Delete (409 if in use)
```
