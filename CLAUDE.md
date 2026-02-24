# Appstrate — Developer Guide

Appstrate is an open-source platform for executing one-shot AI flows in ephemeral Docker containers. A user signs up, connects OAuth/API key services (Gmail, ClickUp), clicks "Run", and the AI agent processes their data autonomously inside a temporary container. Flows can also be scheduled via cron, imported from ZIP files, and extended with agent skills.

## Quick Start

```sh
# 1. Start infrastructure
docker compose up -d          # PostgreSQL 16

# 2. Run database migrations
bun run db:generate           # Generate Drizzle migrations from schema
bun run db:migrate            # Apply migrations to PostgreSQL

# 3. Build runtime images
bun run build-runtime         # docker build -t appstrate-pi ./runtime-pi
bun run build-sidecar         # docker build -t appstrate-sidecar ./runtime-pi/sidecar

# 4. Configure .env (copy .env.example, set Pi adapter keys + DB URL + Better Auth secret)

# 5. Build everything (shared-types + frontend)
bun run build                 # turbo build → apps/web/dist/

# 6. Start platform (API + Vite build --watch in parallel)
bun run dev                   # turbo dev → Hono on :3010

# 7. First signup creates an organization automatically
```

## Stack — Critical Constraints

| Constraint | Details |
|------------|---------|
| Runtime | **Bun** everywhere — NOT node. Bun auto-loads `.env` |
| API framework | **Hono** — NOT `Bun.serve()` (need SSE via `streamSSE`, routing, middleware) |
| Docker client | **`fetch()` + unix socket** — NOT dockerode (socket bugs with Bun). See `services/docker.ts` |
| DB security | **No RLS** — app-level security, all queries filter by `orgId` |
| Logging | **`lib/logger.ts`** (JSON to stdout) — no `console.*` calls |
| Auth | **Better Auth** cookie sessions + `X-Org-Id` header. API key auth (`ask_` prefix) tried first, then cookie fallback |
| Env validation | **`@appstrate/env`** (Zod schema) is the single source of truth — not `.env.example` |

## Navigating the Codebase

```
appstrate/
├── apps/api/src/             # @appstrate/api — Hono backend (:3010)
│   ├── index.ts              # Entry: middleware, auth, startup init
│   ├── routes/               # Route handlers (one file per domain)
│   ├── services/             # Business logic, Docker, adapters, scheduler
│   ├── openapi/              # OpenAPI 3.1 spec (source of truth for all endpoints)
│   │   └── paths/            # One file per route domain (82 endpoints)
│   └── types/                # Backend types + re-exports from shared-types
│
├── apps/web/src/             # @appstrate/web — React 19 + Vite + React Query v5
│   ├── pages/                # Route pages (React Router v7 BrowserRouter)
│   ├── hooks/                # React Query hooks + SSE realtime hooks
│   ├── components/           # UI components (modals, forms, editors)
│   ├── styles.css            # Single CSS file (dark theme, no Tailwind/modules)
│   └── i18n.ts               # i18next: fr (default) + en, namespaces: common/flows/settings
│
├── packages/db/src/          # @appstrate/db — Drizzle ORM + Better Auth
│   ├── schema.ts             # Full schema (25 tables, enums, indexes)
│   ├── client.ts             # db + listenClient (LISTEN/NOTIFY)
│   └── auth.ts               # Better Auth config (auto profile+org on signup)
│
├── packages/env/src/         # @appstrate/env — Zod env validation (authoritative)
├── packages/shared-types/    # @appstrate/shared-types — Drizzle InferSelectModel re-exports
├── packages/connect/         # @appstrate/connect — OAuth2/PKCE, API key, credential encryption
│
├── data/                     # Built-in resources (loaded at boot)
│   ├── flows/{name}/         # manifest.json + prompt.md
│   ├── providers.json        # Merged with SYSTEM_PROVIDERS env var
│   ├── skills/{id}/SKILL.md  # YAML frontmatter (name, description)
│   └── extensions/{id}.ts    # Pi agent tools (ExtensionFactory pattern)
│
├── runtime-pi/               # Docker image: Pi Coding Agent SDK
│   ├── entrypoint.ts         # SDK session → JSON lines on stdout
│   └── sidecar/server.ts     # Credential-isolating HTTP proxy (Hono)
│
└── scripts/verify-openapi.ts # bun run verify:openapi
```

**Workspace imports**: `@appstrate/db/schema`, `@appstrate/db/client`, `@appstrate/env`, `@appstrate/connect`, `@appstrate/shared-types`.

## Architecture

```
User Browser (BrowserRouter SPA)  Platform (Bun + Hono :3010)
     |                                |
     |-- Login/Signup --------------->|-- Better Auth (email/password → cookie session)
     |                                |
     |-- / (Flow List) -------------->|-- GET /api/flows (with runningExecutions count)
     |-- /flows/:id (Flow Detail) --->|-- GET /api/flows/:id (with services, config, state, skills)
     |-- PUT /api/flows/:id/config -->|-- schema.ts (Zod validation) → state.ts (Drizzle)
     |-- POST /auth/connect/:prov --->|-- connection-manager.ts → OAuth2 flow / API key storage
     |                                |
     |-- POST /api/flows/:id/run ---->|
     |                                |-- 1. Validate deps, config, input (Zod)
     |                                |-- 2. Create execution record (pending, user_id)
     |                                |-- 3. Fire-and-forget: executeFlowInBackground()
     |                                |-- 4. Output validation loop (if output schema)
     |<-- SSE (replay + live) --------|-- 5. Subscribe to logs via pub/sub
     |                                |
     |   Realtime (LISTEN/NOTIFY):    |-- pg_notify triggers on executions + execution_logs
     |   EventSource → SSE endpoints  |-- useExecutionRealtime() + useExecutionLogsRealtime()
     |   + useGlobalExecutionSync()   |-- Patches React Query cache directly (no refetch)
     |                                |
     |   Background Execution:        |-- Runs independently of SSE client
     |                                |-- Persists logs to execution_logs table
     |                                |-- Supports concurrent executions per flow
     |                                |
     |   Scheduler (croner):          |-- Loads enabled schedules from DB at startup
     |                                |-- Cron triggers → triggerScheduledExecution()
     |                                |-- Distributed lock via schedule_runs table
     |                                |-- Uses same executeFlowInBackground() path
     |                                |
     |            Docker network: appstrate-exec-{execId} (isolated bridge)
     |            ┌─────────────────────────────────────────────┐
     |            │  Sidecar Container (alias: "sidecar")       │
     |            │  - EXECUTION_TOKEN, PLATFORM_API_URL        │
     |            │  - Proxies /proxy → credential injection    │
     |            │  - Proxies /execution-history               │
     |            │  - ExtraHosts → host.docker.internal        │
     |            ├─────────────────────────────────────────────┤
     |            │  Agent Container (Pi Coding Agent)          │
     |            │  - FLOW_PROMPT, LLM_*, SIDECAR_URL          │
     |            │  - NO EXECUTION_TOKEN, NO PLATFORM_API_URL  │
     |            │  - NO ExtraHosts (cannot reach host)        │
     |            │  - Calls sidecar via curl for API access    │
     |            │  - Outputs JSON lines on stdout             │
     |            └─────────────────────────────────────────────┘
```

## Key Conventions & Gotchas

### Development Workflow
- **New API route**: Create route file in `routes/` + OpenAPI path file in `openapi/paths/` + wire in `index.ts`. Run `bun run verify:openapi` to validate.
- **DB migration**: Edit `packages/db/src/schema.ts` → `bun run db:generate` → `bun run db:migrate`.
- **Quality gate**: `bun run check` (turbo check = TypeScript across all packages).
- **Tests**: `bun test` in `apps/api/` (tests live in `services/__tests__/` and `routes/__tests__/`).

### Frontend
- **i18n**: `i18next` with `react-i18next`. Default: `fr`, supported: `fr`/`en`. Namespaces: `common`, `flows`, `settings`. Locales in `apps/web/src/locales/{lang}/`.
- **Styling**: Single `styles.css` (dark theme). No CSS modules, no Tailwind, no CSS-in-JS.
- **Auth**: Better Auth React client → `credentials: "include"` on all `apiFetch()` calls. `X-Org-Id` header for org context.
- **Realtime**: SSE EventSource hooks (`use-realtime.ts`) + `useGlobalExecutionSync` patches React Query cache directly.

### Backend
- **Multi-tenant**: All DB queries filter by `orgId`. Admins = org role `admin` or `owner`.
- **Rate limiting**: Token bucket per `method:path:userId`. Key limits: run (20/min), import (10/min), create (10/min).
- **Docker streams**: Multiplexed 8-byte frame headers `[stream_type(1), 0(3), size(4)]` parsed in `streamLogs()`.
- **FlowService**: Built-in flows = immutable `ReadonlyMap` from `data/flows/`. User flows = DB reads on demand.
- **Graceful shutdown**: `execution-tracker.ts` — stop scheduler → reject new POST → wait in-flight (max 30s) → exit.

### Sidecar Protocol (details beyond the architecture diagram)
- Agent calls `$SIDECAR_URL/proxy` with `X-Service` and `X-Target` headers for authenticated API requests.
- Sidecar substitutes `{{variable}}` placeholders in headers/URL, validates against `authorizedUris` per provider.
- **Prompt building**: `buildEnrichedPrompt()` generates sections (User Input, Configuration, Previous State, Execution History API) + appends raw `prompt.md`. No Handlebars.
- **Output validation**: If `output.schema` exists, Zod validates the result. On mismatch, `buildRetryPrompt()` re-executes up to `execution.outputRetries` times. Final failure = accepted with warning.
- **State persistence**: `result.state` → persisted to execution record. Only latest state injected as `## Previous State` next run. Historical executions available via `$SIDECAR_URL/execution-history`.

## API Reference

**The OpenAPI 3.1 spec is the single source of truth for all API endpoints.** It documents 82 endpoints with full request/response schemas, auth requirements, error codes, and SSE event formats.

- **Source files**: `apps/api/src/openapi/` — modular TypeScript files assembled at build time
- **Live spec**: `GET /api/openapi.json` (raw JSON) — public, no auth
- **Interactive docs**: `GET /api/docs` (Swagger UI) — public, no auth
- **Validation**: `bun run verify:openapi` — structural + lint (0 errors/warnings)

When working on API routes, always consult the corresponding OpenAPI path file in `apps/api/src/openapi/paths/` for the authoritative spec. Route domains: `health`, `auth`, `flows`, `executions`, `realtime`, `schedules`, `connections`, `providers`, `api-keys`, `library`, `organizations`, `profile`, `invitations`, `share`, `internal`, `welcome`, `meta`.

## Database

Full schema: `packages/db/src/schema.ts` (25 tables, Drizzle ORM). Migrations: `bun run db:generate` + `bun run db:migrate`. No RLS — app-level security by `orgId`.

## Flow & Extension Gotchas

- **Reference manifest**: `data/flows/pdf-explainer/manifest.json`. Validation: `services/schema.ts`.
- **JSON Schema `required`**: Use top-level `required: ["field1"]` array — NOT `required: true` on individual properties.
- **Extension import**: `@mariozechner/pi-coding-agent` (NOT `pi-agent`).
- **Extension `execute` signature**: `(_toolCallId, params, signal)` — `params` is the **second** argument. Using `execute(args)` receives the toolCallId string.
- **Extension return type**: `{ content: [{ type: "text", text: "..." }] }` — NOT a plain string.
- **Skills**: YAML frontmatter (`name`, `description`) in `SKILL.md`. Available in container at `.pi/skills/{id}/SKILL.md`.

## Known Issues & Technical Debt

1. **No `stream: false` mode**: The execution route always returns SSE. The spec defines a synchronous mode — not yet implemented. `stream?: boolean` in request body is ignored.
2. **Scheduler is in-memory**: Cron jobs run in-process via `croner`, re-loaded from DB on restart. Distributed locking via `schedule_runs` table prevents duplicates.

## Detailed Specs

The full product specifications are in the Obsidian vault at:

```
/Users/pierrecabriere/Library/Mobile Documents/iCloud~md~obsidian/Documents/main/projects/claude-flows/
├── claude-flows-mvp.md              # MVP scope, architecture, milestones
├── claude-flows-mvp-api.md          # API spec with all endpoints, payloads, SSE events, error codes
├── claude-flows-mvp-flow-format.md  # Flow package format: manifest spec, prompt template syntax
└── claude-flows-mvp-first-flow.md   # email-to-tickets flow: functional spec, prompt, test scenarios
```
