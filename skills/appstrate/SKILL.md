---
name: appstrate
description: Create, deploy, run, and iterate on AI agents on Appstrate, the open-source platform that runs agents as one-shot AI workflows in ephemeral Docker containers. Supports named profiles so a single session can pilot cloud, self-hosted, and dev instances. Use when the user wants to create or edit an agent (manifest.json + prompt.md), deploy or run a .afps package, run an agent inline without import, validate a manifest, monitor runs, manage skills/tools/providers, connect OAuth or API-key services, schedule agents, write prompts, or call the REST API. Also triggers on mentions of AFPS, scoped packages (`@scope/name`), inline runs, sidecar proxy, "on cloud", "on local", "on dev", or appstrate.com.
---

# Appstrate

Manage AI agents on [appstrate.com](https://app.appstrate.com) via its REST API. Everything is a **package** with a scoped name (`@scope/name`). Four types: `agent`, `skill`, `tool`, `provider`.

- **API docs**: https://app.appstrate.com/api/docs
- **OpenAPI spec**: `GET https://app.appstrate.com/api/openapi.json`
- **GitHub (open-source)**: https://github.com/appstrate/appstrate

## Setup

Three env vars required per instance: `APPSTRATE_URL`, `APPSTRATE_API_KEY`, `APPSTRATE_ORG_ID`.

For first-time setup (create API key, get org ID — or self-host your own instance via `curl -fsSL https://get.appstrate.dev | bash`): read `references/setup.md`.

For multi-instance setups (cloud + self-hosted + dev): use named profiles under `~/.config/appstrate/profiles/<name>.env`. Full guide: `references/profiles.md`.

### Find credentials (resolution order)

On every API call, resolve the active instance in this order — first match wins:

```bash
# 1. APPSTRATE_PROFILE env var → load that profile file
if [ -n "$APPSTRATE_PROFILE" ] && [ -f ~/.config/appstrate/profiles/"$APPSTRATE_PROFILE".env ]; then
  set -a; . ~/.config/appstrate/profiles/"$APPSTRATE_PROFILE".env; set +a

# 2. default-profile pointer (used when no explicit profile is set)
elif [ -f ~/.config/appstrate/default-profile ]; then
  p=$(cat ~/.config/appstrate/default-profile)
  [ -f ~/.config/appstrate/profiles/"$p".env ] && { set -a; . ~/.config/appstrate/profiles/"$p".env; set +a; }

# 3. Legacy: APPSTRATE_URL / APPSTRATE_API_KEY / APPSTRATE_ORG_ID already exported
elif env | grep -q APPSTRATE_URL; then : ;

# 4. Legacy fallback: project .env files
elif [ -f .env ] && grep -q APPSTRATE .env; then set -a; . ./.env; set +a

# 5. Legacy fallback: coding-agent config dirs
else
  for dir in ~/.claude ~/.cursor ~/.windsurf ~/.codeium ~/.zed ~/.continue ~/.aider ~/.config/github-copilot; do
    [ -f "$dir/.env" ] && grep -q APPSTRATE "$dir/.env" && { set -a; . "$dir/.env"; set +a; break; }
  done
fi
```

**Inferring a profile from the prompt**: when the user says "on cloud" / "en prod" → use `cloud`; "on local" / "sur mon install" → use `local`; "on dev" → use `dev`. If the named profile doesn't exist, list `ls ~/.config/appstrate/profiles/` and ask which to use. See `references/profiles.md` for the full mapping and for cross-instance iteration patterns (e.g., "list agents across all my instances").

If no credentials are found anywhere, ask the user to provide them or follow `references/setup.md` to create them.

### Verify

```bash
curl -s "$APPSTRATE_URL/api/agents" \
  -H "Authorization: Bearer $APPSTRATE_API_KEY" \
  -H "X-Org-Id: $APPSTRATE_ORG_ID" | head -c 200
```

## API Conventions

**Auth headers** — every request needs both:

```
Authorization: Bearer $APPSTRATE_API_KEY
X-Org-Id: $APPSTRATE_ORG_ID
```

**Scoped routes** — scope MUST include the `@` prefix: `@tractr/my-agent`, NOT `tractr/my-agent`. Without `@`, routes will NOT reach the API.

**RTK proxy** — if RTK (Rust Token Killer) is installed, it intercepts `curl` output and replaces JSON values with type placeholders (e.g., `string`, `int`). This breaks API responses where actual data is needed. Always prefix curl commands with `rtk proxy` to bypass the filter:

```bash
rtk proxy curl -s "$APPSTRATE_URL/api/agents" \
  -H "Authorization: Bearer $APPSTRATE_API_KEY" \
  -H "X-Org-Id: $APPSTRATE_ORG_ID"
```

All curl examples below omit auth headers and `rtk proxy` prefix for brevity — always include them.

## Quick Reference

| Task                             | Action                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| Create an agent                  | Write manifest.json + prompt.md, pack as .afps, import                                  |
| Run an agent (persisted)         | `POST /api/agents/@scope/name/run`                                                      |
| Run an agent (inline, no import) | `POST /api/runs/inline` — manifest + prompt in body, returns `202 { runId, packageId }` |
| Validate a manifest (dry-run)    | `POST /api/runs/inline/validate` — preflight without firing, no credits burned          |
| Check status                     | `GET /api/runs/{id}` or SSE stream                                                      |
| View logs                        | `GET /api/runs/{id}/logs`                                                               |
| List runs globally               | `GET /api/runs?kind=all\|package\|inline&status=...&startDate=...`                      |
| Update an agent                  | Bump version in manifest.json, re-pack, re-import                                       |
| Schedule an agent                | `POST /api/agents/@scope/name/schedules` (inline runs are not schedulable)              |
| List everything                  | `GET /api/agents`, `/api/packages/skills`, `/api/packages/tools`                        |
| Manage applications              | `GET/POST /api/applications` (headless multi-tenant)                                    |
| Manage end users                 | `GET/POST /api/end-users` (per-application)                                             |
| Upload files                     | `POST /api/uploads/request` → upload → `POST /api/uploads/confirm`                      |
| Configure OAuth clients          | `GET/POST /api/oauth-clients` (OIDC provider)                                           |

For API conventions, gotchas, and rate limits: read `references/api-cheatsheet.md`. For the full endpoint list, fetch the live OpenAPI spec: `GET https://app.appstrate.com/api/openapi.json`.

## Create an Agent

### 0. Discover available resources

Before writing the manifest, check what's available in the org:

```bash
# System tools (output, set-state, report, log, add-memory)
curl "$APPSTRATE_URL/api/packages/tools"

# Skills (knowledge packages to attach)
curl "$APPSTRATE_URL/api/packages/skills"

# Providers (OAuth/API-key services to connect)
curl "$APPSTRATE_URL/api/providers"

# Existing agents (avoid name collisions)
curl "$APPSTRATE_URL/api/agents"
```

Use these results to choose the right `dependencies.tools`, `dependencies.skills`, and `dependencies.providers` for the manifest. For system tools details and decision guide: read `references/system-tools.md`.

### 1. Write manifest.json

Use the template at `assets/agent-manifest.json`. Key fields:

```json
{
  "name": "@my-org/my-agent",
  "version": "1.0.0",
  "type": "agent",
  "schemaVersion": "1.0",
  "displayName": "My Agent",
  "description": "What it does",
  "author": "Author",
  "dependencies": {
    "providers": { "@appstrate/gmail": "^1.0.0" },
    "tools": { "@appstrate/output": "^1.0.0" },
    "skills": {}
  },
  "providersConfiguration": {
    "@appstrate/gmail": {
      "scopes": ["https://www.googleapis.com/auth/gmail.modify"],
      "connectionMode": "user"
    }
  },
  "input": { "schema": { "type": "object", "properties": {}, "required": [] } },
  "output": {
    "schema": {
      "type": "object",
      "properties": { "summary": { "type": "string" } },
      "required": ["summary"]
    }
  },
  "timeout": 300
}
```

Critical rules:

- `name` MUST be `@scope/name` format (lowercase, hyphens OK)
- `type` is `"agent"`
- `dependencies.tools` — system tools are NOT auto-enabled. Declare each tool the agent needs (see `references/system-tools.md` for the decision guide)
- `dependencies.providers` is `Record<string, semverRange>` (NOT an array)
- `required` is a top-level array (NOT `required: true` on properties)
- `connectionMode`: `"user"` (each user connects) or `"admin"` (shared creds)

For the full manifest schema: read `references/manifest-schema.md`.

### 2. Write prompt.md

The agent prompt. Plain Markdown, no template syntax. The platform auto-injects: User Input, Configuration, Previous State, Memory, Tools, Skills, Connected Providers, Output Format.

```markdown
# Objective

One clear sentence.

# Steps

1. **Fetch data** — Use sidecar proxy for authenticated calls:
   curl -s "$SIDECAR_URL/proxy" \
    -H "X-Provider: @appstrate/gmail" \
    -H "X-Target: https://gmail.googleapis.com/gmail/v1/users/me/messages" \
    -H "Authorization: Bearer {{access_token}}"
2. **Process** — Transform, filter, summarize
3. **Return results** as JSON matching the output schema
```

Key rules:

- Sidecar proxy: `$SIDECAR_URL/proxy` + `X-Provider` + `X-Target` headers
- Credential placeholders: `{{access_token}}` (OAuth2), `{{apiKey}}` (API key), `{{fieldName}}` (custom)
- Public APIs: call directly with curl, no sidecar needed
- Do NOT repeat injected sections (User Input, Config, etc.)
- If `@appstrate/output` is in dependencies, instruct the agent to call the `output` tool to return structured results

For detailed prompt guidance: read `references/prompt-writing.md`.

### 3. Package as .afps

```bash
bash scripts/afps-pack.sh /path/to/agent-dir /tmp/my-agent.afps
```

The .afps is a ZIP with manifest.json at root (not nested). Manual alternative:

```bash
cd "$AGENT_DIR" && zip -r /tmp/my-agent.afps manifest.json prompt.md
```

### 4. Import

```bash
curl -X POST "$APPSTRATE_URL/api/packages/import" \
  -F "file=@/tmp/my-agent.afps"
```

If 409 `DRAFT_OVERWRITE`: add `?force=true` to overwrite the draft.

### 5. Configure (optional post-import)

```bash
# Attach skills
curl -X PUT "$APPSTRATE_URL/api/agents/@scope/name/skills" \
  -H "Content-Type: application/json" \
  -d '{"skillIds": ["@scope/skill1"]}'

# Set config values
curl -X PUT "$APPSTRATE_URL/api/agents/@scope/name/config" \
  -H "Content-Type: application/json" \
  -d '{"language": "fr"}'

# Override LLM model
curl -X PUT "$APPSTRATE_URL/api/agents/@scope/name/model" \
  -H "Content-Type: application/json" \
  -d '{"modelId": "claude-sonnet-4-20250514"}'
```

## Run an Agent

```bash
# Basic run
curl -X POST "$APPSTRATE_URL/api/agents/@scope/name/run" \
  -H "Content-Type: application/json" \
  -d '{"input": {"query": "weekly report"}}'

# With file upload (multipart)
curl -X POST "$APPSTRATE_URL/api/agents/@scope/name/run" \
  -F 'input={"description": "Process this"}' \
  -F "file=@/path/to/file.pdf"

# Specific version
curl -X POST "$APPSTRATE_URL/api/agents/@scope/name/run?version=1.0.0" ...
```

### Monitor

```bash
# Status
curl "$APPSTRATE_URL/api/runs/{id}"

# Logs
curl "$APPSTRATE_URL/api/runs/{id}/logs"

# Cancel
curl -X POST "$APPSTRATE_URL/api/runs/{id}/cancel"

# SSE realtime stream
curl -N "$APPSTRATE_URL/api/realtime/runs/{id}"

# Global run list (cross-agent, supports kind=all|package|inline, status, date filters)
curl "$APPSTRATE_URL/api/runs?kind=inline&status=success&limit=50"
```

Status lifecycle: `pending` → `running` → `success` | `failed` | `timeout` | `cancelled`

## Run Inline (No Package Import)

For one-shot agents or rapid iteration, skip the pack/import cycle: `POST /api/runs/inline` accepts a full manifest + prompt in the request body. The platform creates an **ephemeral shadow package** (`@inline/r-<uuid>`, hidden from catalog queries), runs it through the standard pipeline, and compacts the manifest/prompt after `retention_days` (default 30).

```bash
# Execute — returns 202 { runId, packageId }
curl -X POST "$APPSTRATE_URL/api/runs/inline" \
  -H "Content-Type: application/json" \
  -d '{
    "manifest": { "name": "@inline/summary", "version": "0.0.0", "type": "agent", "schemaVersion": "1.0", "dependencies": { "tools": { "@appstrate/output": "^1.0.0" } } },
    "prompt": "Summarize the input in three bullets.",
    "input": { "text": "..." }
  }'

# Dry-run validator — same body, no side effects, returns 200 { ok: true } or 400 problem+json
curl -X POST "$APPSTRATE_URL/api/runs/inline/validate" \
  -H "Content-Type: application/json" \
  -d '{ "manifest": {...}, "prompt": "...", "input": {...} }'
```

Key rules:

- Dependencies (`skills`, `tools`, `providers`) must reference **existing** org/system packages — no new inline definitions
- Not schedulable (schedules require a persisted package)
- `/validate` shares the same rate bucket as `/inline` — debounce tight iteration loops
- After compaction, `inlineManifest` / `inlinePrompt` become `null` (run row + result persist)
- Every run (classic AND inline) now persists a **config snapshot** on `runs.config` — the Run Info tab renders it, decoupled from the package's current config

Limits via `INLINE_RUN_LIMITS` env var: `rate_per_min=60`, `manifest_bytes=65536`, `prompt_bytes=200000`, `max_skills=20`, `max_tools=20`, `max_authorized_uris=50`, `wildcard_uri_allowed=false`, `retention_days=30`.

For full request/response schemas, gotchas, and when to choose inline vs package import: read `references/inline-runs.md`.

## Update an Agent (Iterate)

1. Edit prompt.md and/or manifest.json
2. Bump version (e.g., `1.0.0` → `1.1.0`)
3. Re-pack: `bash scripts/afps-pack.sh $AGENT_DIR /tmp/my-agent.afps`
4. Re-import: `curl -X POST "$APPSTRATE_URL/api/packages/import" -F "file=@/tmp/my-agent.afps"`

Same version + `?force=true` overwrites the draft (no version history). Always prefer bumping.

## Schedule an Agent

```bash
curl -X POST "$APPSTRATE_URL/api/agents/@scope/name/schedules" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Daily digest",
    "cronExpression": "0 9 * * 1-5",
    "timezone": "America/Montreal",
    "connectionProfileId": "profile-uuid",
    "input": {"maxItems": 20}
  }'
```

Common cron patterns: `0 9 * * 1-5` (weekdays 9am), `0 */6 * * *` (every 6h), `0 0 * * 1` (weekly Monday).

## Create a Skill or Tool

Skills and tools follow the same import workflow. Pack as .afps with manifest.json at root.

**Skill** (knowledge for the agent):

```
manifest.json    # type: "skill"
SKILL.md         # YAML frontmatter + Markdown content
scripts/         # Optional bundled scripts
references/      # Optional reference docs
```

**Tool** (executable TypeScript extension):

```
manifest.json    # type: "tool", with entrypoint and tool.inputSchema
index.ts         # Tool implementation using @mariozechner/pi-coding-agent
```

Templates: `assets/skill-manifest.json`, `assets/tool-manifest.json`.

For tool conventions (execute signature, return format): read `references/manifest-schema.md` > Tool section.

## Data Model: input vs config vs state vs memory vs output

| Mechanism  | Changes each run? | Who sets it? |     Persists?     | Use for                                 |
| ---------- | :---------------: | :----------: | :---------------: | --------------------------------------- |
| **input**  |        Yes        |   End user   |        No         | Runtime params: query, date range, file |
| **config** |      Rarely       |    Admin     |        Yes        | Setup-once: language, max items         |
| **output** |        Yes        |    Agent     |        No         | Structured results for the user         |
| **state**  |        Yes        |    Agent     | Yes (overwritten) | Cursor, last sync timestamp             |
| **memory** |        Yes        |    Agent     |  Yes (appended)   | Learned preferences, patterns           |

## Common Errors

| Error                            | Cause                                            | Fix                                                          |
| -------------------------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| `result: {}` on success          | `@appstrate/output` not in `dependencies.tools`  | Add `"@appstrate/output": "^1.0.0"` to manifest dependencies |
| 409 `DRAFT_OVERWRITE`            | Package has unpublished changes                  | Add `?force=true` to import URL                              |
| 403 `agents:write required`      | API key missing new scopes after platform update | Create a new API key in the UI                               |
| HTML response instead of JSON    | Missing `@` in scope                             | Use `@scope/name`, not `scope/name`                          |
| Agent doesn't call `output` tool | Tool not in available tool list                  | Verify `dependencies.tools` in manifest, re-import           |

## References

| Need                                                 | File                                             |
| ---------------------------------------------------- | ------------------------------------------------ |
| Platform concepts (visual overview)                  | `references/concepts.md`                         |
| Full manifest schema (all 4 types)                   | `references/manifest-schema.md`                  |
| Writing effective prompts                            | `references/prompt-writing.md`                   |
| System tools (output, state, report, etc.)           | `references/system-tools.md`                     |
| API conventions & gotchas                            | `references/api-cheatsheet.md`                   |
| Inline runs (endpoints, limits, compaction, gotchas) | `references/inline-runs.md`                      |
| Multi-instance profiles (cloud + local + dev)        | `references/profiles.md`                         |
| Full endpoint list (live)                            | `GET https://app.appstrate.com/api/openapi.json` |
| Step-by-step setup guide                             | `references/setup.md`                            |
