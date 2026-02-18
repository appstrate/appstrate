# Create a New Appstrate Flow

You are creating a new flow for the Appstrate platform. A flow is a one-shot AI task executed in an ephemeral Docker container by the Pi Coding Agent. The user will describe what the flow should do, and you will generate the complete flow package.

## What You Must Produce

A flow is a directory containing:

```
{flow-name}/
  manifest.json      # Required: flow definition, schema, metadata
  prompt.md          # Required: agent instructions (the prompt the Pi agent will execute)
  skills/            # Optional: reusable knowledge modules
    {skill-id}/
      SKILL.md       # Skill definition with YAML frontmatter
```

The flow can be delivered in two ways:
- **Built-in flow**: Written directly to `flows/{flow-name}/` — loaded at server startup
- **ZIP package**: Packaged as `{flow-name}.zip` — importable via the UI or `POST /api/flows/import`

Ask the user which delivery mode they prefer. Default to ZIP if not specified, as it's the most portable format and doesn't require a server restart.

## Step 1: Gather Requirements

Before writing anything, ask the user about:

1. **What the flow does** — what data it processes, what actions it takes, what output it produces
2. **Which external services** it needs (Gmail, ClickUp, Google Calendar, Brevo, or others). Each service must be a Nango integration. Check available integrations with the user.
3. **User input** — does the flow need per-execution input from the user? (e.g., a search topic, a date range)
4. **Configuration** — what parameters should be configurable between runs? (e.g., max items to process, language, target list/folder IDs)
5. **State persistence** — does the flow need to remember anything between runs? (e.g., last_run timestamp, last processed item ID for incremental runs)
6. **Output structure** — what fields should the result contain? Defining output.schema enables automatic Zod validation with retry.

## Step 2: Create manifest.json

The manifest defines everything about the flow. Follow this structure exactly:

```json
{
  "$schema": "https://appstrate.dev/schemas/manifest-v1.json",
  "version": "1.0.0",

  "metadata": {
    "name": "my-flow-name",
    "displayName": "Human-Readable Name",
    "description": "One-line description of what this flow does",
    "author": "appstrate",
    "license": "MIT",
    "tags": ["tag1", "tag2"]
  },

  "requires": {
    "services": [],
    "tools": []
  },

  "execution": {
    "timeout": 300,
    "maxTokens": 50000
  }
}
```

### Manifest Rules

**metadata.name**: Kebab-case, unique across all flows. This becomes the flow ID. Examples: `email-summary`, `slack-digest`, `invoice-processor`.

**requires.services[]**: Each service the agent needs OAuth/API tokens for:
```json
{
  "id": "gmail",
  "provider": "google-mail",
  "scopes": ["https://www.googleapis.com/auth/gmail.readonly"],
  "description": "Lecture des mails"
}
```
- `id`: Short name used in env vars. The token is injected as `TOKEN_{ID_UPPERCASED}` (hyphens become underscores: `brevo-api-key` → `TOKEN_BREVO_API_KEY`)
- `provider`: Must match a Nango integration unique_key. Known providers: `google-mail`, `google-calendar`, `clickup`, `brevo-api-key`
- `scopes` (optional): OAuth scopes needed. Omit for API key integrations (e.g., Brevo)
- `description`: Shown in the UI to explain why this service is needed

**requires.tools[]**: Platform tools the agent can use:
```json
{ "id": "web-search", "type": "static", "description": "Web search for context enrichment" }
```
Currently the only available tool is `web-search` (static). Leave as empty array `[]` if not needed.

**input.schema** (optional): Per-execution user input. The user fills a form before each run:
```json
"input": {
  "schema": {
    "topic": {
      "type": "string",
      "description": "Sujet a rechercher",
      "required": true,
      "placeholder": "ex: intelligence artificielle, design..."
    },
    "date_range": {
      "type": "number",
      "description": "Nombre de jours en arriere",
      "default": 7
    }
  }
}
```
Field types: `string`, `number`, `boolean`, `array`, `object`. Values are automatically injected as a structured `## User Input` section before the prompt, with field descriptions and types from the schema.

**config.schema** (optional): User-configurable parameters that persist between runs:
```json
"config": {
  "schema": {
    "max_items": {
      "type": "number",
      "default": 20,
      "description": "Maximum items to process per run"
    },
    "target_id": {
      "type": "string",
      "required": true,
      "description": "Target list/folder/workspace ID"
    },
    "language": {
      "type": "string",
      "default": "fr",
      "enum": ["fr", "en"],
      "description": "Output language"
    }
  }
}
```
Supports `default`, `required`, `enum`. Values are automatically injected as a structured `## Configuration` section before the prompt, with field descriptions and types from the schema.

**Execution-level state** (automatic): The agent can include a `state` object in its JSON output. The platform persists it on the execution record. Before the next run, the latest execution's state is injected as `## Previous State`. The agent can also fetch historical executions on demand via `GET /internal/execution-history` (authenticated with `$EXECUTION_TOKEN`, documented in `## Execution History API` section). No manifest declaration needed — state is free-form.

**output.schema** (recommended): Expected result structure. Enables Zod validation + automatic retry:
```json
"output": {
  "schema": {
    "summary": {
      "type": "string",
      "description": "Execution summary",
      "required": true
    },
    "items_processed": {
      "type": "number",
      "description": "Count of items processed"
    },
    "results": {
      "type": "array",
      "description": "Processed items with details",
      "required": true
    }
  }
}
```
When defined, the platform validates the agent's JSON output. On mismatch, it sends a retry prompt describing the errors (up to `execution.outputRetries` times, default 2). Always include a `summary` field (string, required).

**execution**: Resource limits:
- `timeout`: Seconds before the container is killed (120-600, typically 180-300)
- `maxTokens`: Token budget for the agent (10000-100000)
- `outputRetries`: Number of retry attempts for output validation (0-5, default 2)

Scale these to flow complexity: simple read-only = 180s/30000, complex multi-service = 300-600s/100000.

## Step 3: Write prompt.md

The prompt is the core of the flow. It's what the Pi agent executes inside the container.

### How Context is Injected

The platform automatically prepends structured sections before the prompt:
- `## API Access` — Token env vars and curl examples for each connected service
- `## User Input` — All input field values with descriptions and types from the schema
- `## Configuration` — All config field values with descriptions and types from the schema
- `## Previous State` — latest execution's state JSON (if any)
- `## Execution History API` — curl command to fetch historical executions on demand
- `## Output Format` — Expected output structure from output.schema

**The prompt.md is appended as-is after these sections.** No template interpolation — write plain Markdown. The agent sees all context in the structured sections above the prompt.

### Prompt Structure Best Practices

```markdown
# Flow Title

## Objective
Clear, one-paragraph description of what the agent must do.

## Steps

### 1. Fetch Data
Explain how to fetch data from the service API.
Include curl examples with the correct token variable.

Example for Gmail:
curl -s -H "Authorization: Bearer $TOKEN_GMAIL" \
  "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20"

### 2. Process Data
Explain the processing logic, classification rules, etc.
Reference values from the Configuration and User Input sections above as needed.

### 3. Generate Output
Explain the expected output structure.

## Incremental Processing
If previous state is available (see Previous State section above), only process items since the last run.
For deeper history, use the Execution History API to fetch older executions on demand.
On first run, process all recent items.

## Output Format
Return a JSON object in a ```json code block with the following structure:
{
  "summary": "...",
  "results": [...],
  "state": {
    "last_run": "ISO 8601 timestamp of this run"
  }
}

## Rules
- Read-only: NEVER modify, delete, or archive source data
- Handle API errors gracefully
- If no new data, return an empty result with an appropriate summary
- Always include a `state` object with `last_run` for incremental processing
```

### Prompt Writing Rules

1. **Be explicit about API calls**: Include full curl examples with correct endpoints, headers, and token variables. The agent has no built-in knowledge of API specifics. Example:
   ```
   curl -s -H "Authorization: Bearer $TOKEN_CLICKUP" \
     "https://api.clickup.com/api/v2/team"
   ```

2. **Token variable naming**: Service ID hyphens become underscores. `google-mail` with id `gmail` → `$TOKEN_GMAIL`. `brevo-api-key` with id `brevo-api-key` → `$TOKEN_BREVO_API_KEY`.

3. **Read-only by default**: Always state explicitly that the agent must not modify source data (no archiving emails, no deleting tasks, no sending messages) unless the flow's purpose requires writes.

4. **Handle incremental runs**: If the flow uses state, instruct the agent to check the Previous State section for `last_run` and filter data since last execution. For deeper history, the agent can use the Execution History API. Also handle the first-run case (no previous state).

5. **Define output precisely**: Describe each field, its type, and what it contains. The more specific, the better the agent's output quality.

6. **Include classification rules**: If the flow categorizes data, define clear categories with examples. Don't leave ambiguity — default behavior should be stated (e.g., "en cas de doute, classer comme INFO").

7. **Budget awareness**: The agent has limited tokens. Tell it to be concise, limit web searches, and focus on the essential task.

8. **Language**: Write the prompt in the language matching the flow's default `config.language`. French flows get French prompts.

9. **JSON output is mandatory**: The agent MUST output a ```json code block. This is how the platform extracts the result. Always end the prompt with a clear output format section.

10. **State persistence**: If using state, always instruct the agent to include a `state` object in its JSON output. The platform persists this on the execution record and injects the latest state as `## Previous State` on the next run. Historical executions are available on demand via the Execution History API.

## Step 4: Create Skills (Optional)

Skills are reusable knowledge modules that provide the agent with domain expertise, templates, or best practices. They're mounted as files inside the container at `/workspace/.claude/skills/`.

### When to Create Skills

- The flow needs domain-specific knowledge (API patterns, formatting rules, classification taxonomies)
- You want to share behavior patterns across multiple flows
- The prompt would be too long without extracting reusable parts

### Skill File Format

```
skills/{skill-id}/SKILL.md
```

The SKILL.md file has YAML frontmatter and markdown content:

```markdown
---
name: skill-id
description: One-line description of when to use this skill. The agent reads this to decide if the skill is relevant.
---

# Skill Title

## When to Use
- Situation 1
- Situation 2

## Guidelines
Detailed instructions, templates, patterns, examples.

## Examples
Concrete examples of input → output.
```

### Skill Best Practices

- **Descriptive frontmatter**: The `description` field is what the agent sees first. Make it actionable: "Use this skill when you need to..." or "Use this skill to format..."
- **Focused scope**: One skill = one capability. Don't create Swiss-army-knife skills.
- **Templates over instructions**: Provide concrete templates the agent can adapt, not abstract guidelines.
- **The skill-id must be a valid directory name**: Use kebab-case, no spaces.

### How Skills Work at Runtime

1. The flow directory (including `skills/`) is mounted read-only at `/workspace/flow/`
2. The entrypoint creates symlinks: `/workspace/flow/skills/{id}/` → `/workspace/.pi/skills/{id}/`
3. The Pi agent can discover and read skills from `/workspace/.pi/skills/`
4. Skills are also listed in the flow detail API response (`requires.skills[]`)

## Step 5: Write Files and Package

### File creation

Write all flow files to a temporary build directory first:

```
/tmp/appstrate-flow-{flow-name}/
  {flow-name}/
    manifest.json
    prompt.md
    skills/              # Only if skills were created
      {skill-id}/
        SKILL.md
```

Use the Write tool to create each file with the final content.

### Built-in flow (direct install)

If the user chose built-in delivery, copy the files to the flows directory:

```bash
cp -r /tmp/appstrate-flow-{flow-name}/{flow-name} flows/{flow-name}
```

The server must be restarted (`bun run dev`) to pick up the new flow.

### ZIP package (importable)

If the user chose ZIP delivery (or by default), create the ZIP archive:

```bash
cd /tmp/appstrate-flow-{flow-name} && zip -r {flow-name}.zip {flow-name}/
```

Then copy the ZIP to the project root (or wherever the user wants):

```bash
cp /tmp/appstrate-flow-{flow-name}/{flow-name}.zip /Users/pierrecabriere/Dev/appstrate/{flow-name}.zip
```

Tell the user:
- The ZIP is at `{flow-name}.zip` in the project root
- They can import it via the UI: go to the Flows page, click "Importer", select the ZIP
- Or via API: `curl -X POST -F "file=@{flow-name}.zip" -H "Authorization: Bearer $AUTH_TOKEN" http://localhost:3000/api/flows/import`
- Imported flows are stored in the database and don't require a server restart

### ZIP format requirements

The import system (`flow-import.ts`) accepts two ZIP structures:
- **Flat**: `manifest.json` + `prompt.md` + `skills/` at the root of the ZIP
- **Single folder** (preferred): A single top-level directory containing all files (like GitHub ZIP downloads)

Always use the single-folder structure (`{flow-name}/manifest.json`, `{flow-name}/prompt.md`, etc.) as it's cleaner and matches the platform convention.

The ZIP must be under 10 MB. The importer validates:
- `manifest.json` exists and is valid (Zod schema validation)
- `prompt.md` exists
- `metadata.name` doesn't collide with an existing flow
- Skills in `skills/{id}/SKILL.md` are extracted automatically

### Cleanup

After delivery, clean up the temp directory:

```bash
rm -rf /tmp/appstrate-flow-{flow-name}
```

## Step 6: Validate

After creating the flow files (before packaging):

1. **Check the manifest is valid JSON**: `cat /tmp/appstrate-flow-{flow-name}/{flow-name}/manifest.json | jq .`
2. **Verify prompt doesn't use template syntax**: Prompts should NOT contain `{{...}}` — all context is injected automatically as structured sections
3. **Verify service IDs**: Each service in `requires.services` must reference a real Nango provider
4. **For built-in flows**: Restart the dev server (`bun run dev`), the flow should appear in the flow list. Check the logs for "Loaded flow: {name}"
5. **For ZIP imports**: Import via the UI or API, check the flow appears in the flow list without restart

## Available Nango Providers

These integrations are set up by default (via `scripts/setup-nango.ts`):

| Provider Key | Type | Description |
|---|---|---|
| `google-mail` | OAuth2 | Gmail read access |
| `google-calendar` | OAuth2 | Google Calendar read access |
| `clickup` | OAuth2 | ClickUp task management |
| `brevo-api-key` | API_KEY | Brevo email marketing API |

If the flow needs a service not in this list, tell the user they need to:
1. Add the integration to Nango (via Nango UI at :3003 or `setup-nango.ts`)
2. Reference the correct `provider` key in the manifest

## Reference: Complete Manifest Example

```json
{
  "$schema": "https://appstrate.dev/schemas/manifest-v1.json",
  "version": "1.0.0",

  "metadata": {
    "name": "email-to-tickets",
    "displayName": "Email -> Tickets",
    "description": "Reads recent emails and creates tickets for actionable items",
    "author": "appstrate",
    "license": "MIT",
    "tags": ["email", "productivity", "tickets"]
  },

  "requires": {
    "services": [
      {
        "id": "gmail",
        "provider": "google-mail",
        "scopes": ["https://www.googleapis.com/auth/gmail.readonly"],
        "description": "Read emails"
      },
      {
        "id": "clickup",
        "provider": "clickup",
        "scopes": ["task:write"],
        "description": "Create tickets"
      }
    ],
    "tools": [
      { "id": "web-search", "type": "static", "description": "Web search for context" }
    ]
  },

  "input": {
    "schema": {
      "focus_topic": {
        "type": "string",
        "description": "Optional topic to focus on",
        "placeholder": "e.g. billing, support..."
      }
    }
  },

  "config": {
    "schema": {
      "max_emails": {
        "type": "number",
        "default": 20,
        "description": "Max emails to process"
      },
      "clickup_list_id": {
        "type": "string",
        "required": true,
        "description": "ClickUp list ID for ticket creation"
      },
      "language": {
        "type": "string",
        "default": "fr",
        "enum": ["fr", "en"],
        "description": "Output language"
      }
    }
  },

  "output": {
    "schema": {
      "summary": {
        "type": "string",
        "description": "Execution summary",
        "required": true
      },
      "tickets_created": {
        "type": "array",
        "description": "Created tickets with title, URL, priority",
        "required": true
      },
      "emails_processed": {
        "type": "number",
        "description": "Total emails processed"
      }
    }
  },

  "execution": {
    "timeout": 300,
    "maxTokens": 100000,
    "outputRetries": 2
  }
}
```

## Now: Ask the User

Start by asking the user what flow they want to create. Gather requirements through conversation, then generate the complete flow package (manifest.json + prompt.md + optional skills/). Ask whether they want a built-in flow or a ZIP package (default to ZIP).

When all files are written and validated, package and deliver the flow, then clean up temp files.

$ARGUMENTS
