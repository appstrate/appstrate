# Appstrate — Concepts

- [What is Appstrate?](#what-is-appstrate)
- [Organizations & Access](#organizations--access)
- [Package Types](#package-types)
- [Agent Anatomy & Dependencies](#agent-anatomy--dependencies)
- [How a Run Works](#how-a-run-works)
- [Agent Data Flow](#agent-data-flow)
- [Dependencies](#dependencies)
  - [Providers](#providers)
  - [Tools](#tools)
  - [Skills](#skills)

## What is Appstrate?

An open-source platform that runs AI agents in ephemeral Docker containers. Each agent gets a prompt, tools, connected services, and runs autonomously to produce structured output.

Agents are powered by the [Pi Coding Agent](https://github.com/nichochar/pi-coding-agent) runtime — an open-source SDK that gives the LLM access to bash, file system, and extensible tools inside the container. Appstrate wraps Pi with orchestration (scheduling, auth, state, memory) and a sidecar proxy for secure external API calls.

## Organizations & Access

```
    ┌──────────────────────────────────────────────┐
    │              ORGANIZATION                     │
    │                                               │
    │   Members:                                    │
    │   ├── owner    (full control, billing)        │
    │   ├── admin    (manage agents, providers)     │
    │   └── member   (run agents, view results)     │
    │                                               │
    │   Access:                                     │
    │   ├── UI       (app.appstrate.com)            │
    │   └── API key  (ask_* prefix, scoped)         │
    │                                               │
    │   All agents, skills, tools, providers,       │
    │   connections, and runs are scoped to the org │
    └──────────────────────────────────────────────┘
```

Each API request requires both an API key and an org ID. Keys are created in the UI, start with `ask_`, and can be scoped to specific permissions.

## Package Types

```
                        PACKAGES
    ┌──────────┬──────────┬──────────┬──────────┐
    │  Agent   │  Skill   │   Tool   │ Provider │
    │          │          │          │          │
    │ prompt   │ knowledge│ code the │ external │
    │ + logic  │ for the  │ agent    │ service  │
    │ + schema │ agent    │ can call │ (OAuth,  │
    │          │          │ at       │  API key)│
    │          │          │ runtime  │          │
    └──────────┴──────────┴──────────┴──────────┘

    All share the same scoped name format: @scope/name
    All packaged as .afps (ZIP with manifest.json at root)
```

## Agent Anatomy & Dependencies

```
    ┌──────────────────────────────────────────────────────┐
    │                 @my-org/my-agent                     │
    │                                                      │
    │   manifest.json            prompt.md                 │
    │   ┌────────────────┐      ┌──────────────────┐      │
    │   │ name, version  │      │ # Objective      │      │
    │   │ type: agent    │      │                  │      │
    │   │ input schema   │      │ # Steps          │      │
    │   │ output schema  │      │ 1. Fetch (proxy) │      │
    │   │ timeout        │      │ 2. Process       │      │
    │   │                │      │ 3. Output        │      │
    │   │ dependencies ──┼──┐   └──────────────────┘      │
    │   └────────────────┘  │                              │
    │                       │                              │
    └───────────────────────┼──────────────────────────────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
         providers        tools        skills
              │             │             │
    ┌─────────┴───┐  ┌─────┴───────┐  ┌──┴──────────────┐
    │ Providers   │  │ Tools       │  │ Skills          │
    │             │  │             │  │                 │
    │ external    │  │ system or   │  │ knowledge       │
    │ services    │  │ custom code │  │ injected into   │
    │ (OAuth, API │  │ the agent   │  │ agent prompt    │
    │  key)       │  │ can call    │  │                 │
    └─────────────┘  └─────────────┘  └─────────────────┘
```

## How a Run Works

```
  YOU            APPSTRATE          CONTAINER         SIDECAR          EXTERNAL
   │              CLOUD                │                │           (APIs, Web, LLM)
   │                │                  │                │               │
   │ POST /run      │                  │                │               │
   │ { input }      │                  │                │               │
   │ ────────────>  │                  │                │               │
   │                │  spin up         │                │               │
   │                │ ──────────────>  │                │               │
   │                │                  │                │               │
   │                │  inject:         │                │               │
   │                │  ALWAYS:         │                │               │
   │                │  - prompt.md     │                │               │
   │                │  - output schema │                │               │
   │                │  IF DEFINED:     │                │               │
   │                │  - input         │                │               │
   │                │  - config        │                │               │
   │                │  - prev. state   │                │               │
   │                │  - memories      │                │               │
   │                │  - tools         │                │               │
   │                │  - skills        │                │               │
   │                │  - credentials   │                │               │
   │                │ ──────────────>  │                │               │
   │                │                  │                │               │
   │                │                  │  LLM calls     │  Anthropic,  │
   │                │                  │ ────────────>  │  OpenAI...   │
   │                │                  │ <────────────  │ <──────────> │
   │                │                  │                │               │
   │                │           agent executes          │               │
   │                │                  │                │               │
   │                │                  │  AUTH call     │               │
   │                │                  │  (sidecar      │  OAuth APIs  │
   │                │                  │   proxy)       │  (Drive,     │
   │                │                  │ ────────────>  │   Gmail...)  │
   │                │                  │ <────────────  │ <──────────> │
   │                │                  │                │               │
   │                │                  │  PUBLIC call   │               │
   │                │                  │  (direct curl) │               │
   │                │                  │ ───────────────┼────────────> │
   │                │                  │ <──────────────┼───────────── │
   │                │                  │                │               │
   │  SSE: logs     │    output(data)  │                │               │
   │ <─ ─ ─ ─ ─ ─  │ <─ ─ ─ ─ ─ ─ ─  │                │               │
   │                │                  │                │               │
   │                │  destroy         │                │               │
   │                │ ──────────────>  │                │               │
   │                │                  │                │               │
   │ GET /runs/{id} │                  │                │               │
   │ { result }     │                  │                │               │
   │ <────────────  │                  │                │               │
```

## Agent Data Flow

```
    ┌─────────────────────────────────────────────────────────────┐
    │                   DIFFERENT EACH RUN                         │
    │                                                             │
    │                   │                                         │
    │   INPUT ──────> AGENT ──────> INTERNAL OUTPUT               │
    │   (optional)      │          structured JSON, markdown      │
    │   e.g. query,     │          report — stored in Appstrate   │
    │   file, date      │                                        │
    │   range           │ ──────> EXTERNAL OUTPUT                 │
    │                   │          upload files, send emails,     │
    │                   │          call APIs via sidecar or curl  │
    │                   │                                        │
    └───────────────────┼─────────────────────────────────────────┘
                        │
    ┌───────────────────┼─────────────────────────────────────────┐
    │              SHARED ACROSS RUNS                              │
    │                   │                                         │
    │   CONFIG ─────────┤  (set once via API or UI, rarely        │
    │   e.g. language,  │   changes — injected as                 │
    │   max items,      │   ## Configuration)                     │
    │   target audience │                                         │
    │                   │                                         │
    │   STATE ──────────┤  (overwritten each run, only latest     │
    │   e.g. cursor,    │   value kept — injected as              │
    │   timestamp       │   ## Previous State)                    │
    │                   │                                         │
    │   MEMORY ─────────┘  (appended, never overwritten           │
    │   e.g. learnings,     shared across all users —             │
    │   patterns            injected as ## Memory)                │
    │                                                             │
    └─────────────────────────────────────────────────────────────┘
```

**Example: `@my-org/generate-social-post`**

| Layer      | Set by | When        | Example values                                                    |
| ---------- | ------ | ----------- | ----------------------------------------------------------------- |
| **Config** | Admin  | Once        | `{ "language": "en", "platform": "linkedin", "maxLength": 1500 }` |
| **Input**  | User   | Each run    | `{ "topic": "AI in agencies" }`                                   |
| **Output** | Agent  | Each run    | `{ "post": "AI is transforming...", "hashtags": ["#AI"] }`        |
| **State**  | Agent  | Each run    | `{ "lastTopics": ["AI", "remote", "hiring"] }`                    |
| **Memory** | Agent  | When useful | `"User prefers bullet-point format over long paragraphs"`         |

Same agent, 3 runs — config stays the same, input changes each time:

```
Run 1:  input: { topic: "AI" }         → output: { post: "AI is transforming..." }
Run 2:  input: { topic: "remote" }     → output: { post: "Remote work in..." }
Run 3:  input: { topic: "hiring" }     → output: { post: "Hiring in 2026..." }
        config: { language: "en", platform: "linkedin" }  ← same for all 3
```

## Dependencies

All dependencies must be declared in `dependencies` in the manifest. Nothing is auto-enabled.

### Providers

External services the agent connects to via the sidecar proxy.

```
    ┌────────────────────────────────────────────────────────┐
    │  SYSTEM PROVIDERS (provided by Appstrate)              │
    │                                                        │
    │  Google Drive, Gmail, Slack, HubSpot, GitHub...        │
    │  Full list: GET /api/providers                         │
    ├────────────────────────────────────────────────────────┤
    │  CUSTOM PROVIDERS (created by org admins)              │
    │                                                        │
    │  Any OAuth2, API key, or custom-credentials service    │
    │  Auth modes: oauth2, oauth1, api_key, basic, custom   │
    └────────────────────────────────────────────────────────┘

    Auth mode determines how credentials are injected:
    - OAuth2/OAuth1 → {{access_token}}
    - API key       → {{apiKey}}
    - Custom        → {{fieldName}} per credential field
```

### Tools

Executable code registered as native tools in the agent's tool list (like `bash`, `read`, `edit`). The agent discovers and calls them by name with typed parameters.

Unlike scripts bundled in a skill (which the agent must call manually via `bash`), tools are visible to the LLM, reusable across agents, and return structured output. Custom tools are TypeScript extensions of the [Pi Coding Agent](https://github.com/nichochar/pi-coding-agent) SDK (`@mariozechner/pi-coding-agent`).

```
    ┌────────────────────────────────────────────────────────┐
    │  SYSTEM TOOLS (provided by Appstrate)                  │
    │                                                        │
    │  @appstrate/output      Return structured JSON result  │
    │  @appstrate/report      Generate markdown report       │
    │  @appstrate/set-state   Persist state for next run     │
    │  @appstrate/add-memory  Save long-term learning        │
    │  @appstrate/log         Send real-time progress        │
    ├────────────────────────────────────────────────────────┤
    │  CUSTOM TOOLS (created by users)                       │
    │                                                        │
    │  TypeScript extensions packaged as .afps               │
    │  e.g. @my-org/web-scraper, @my-org/pdf-parser         │
    └────────────────────────────────────────────────────────┘
```

### Skills

Knowledge and scripts injected into the agent's prompt and container. Always created by users or the community — no system skills. Skills follow the [Anthropic Agent Skills](https://docs.anthropic.com/en/docs/claude-code/skills) structure — same SKILL.md format with YAML frontmatter + Markdown body.

```
    my-skill/
    ├── manifest.json          # Appstrate metadata (type: "skill")
    │
    ├── SKILL.md               # Anthropic-compatible skill file
    │   ├── --- (YAML)         #   name, description
    │   └── (Markdown)         #   instructions, workflows
    │
    ├── scripts/               # Deterministic code the agent
    │   └── transform.py       # calls via bash (not reusable
    │                          # across agents — use a tool for that)
    │
    └── references/            # Docs loaded on demand
        └── api-guide.md       # by the agent when needed

    Packaged as .afps → imported via POST /api/packages/import
    Extracted into container at .pi/skills/@scope/name/
```
