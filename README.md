# Appstrate

An open-source platform for executing one-shot AI flows in ephemeral Docker containers. Users sign up, connect OAuth/API key services (Gmail, ClickUp, etc.), click "Run", and the AI agent processes their data autonomously inside a temporary container.

## Features

- **One-shot AI flows** — Each execution runs in an isolated Docker container with a Pi Coding Agent
- **OAuth2 + API key connections** — Connect external services (OAuth2/PKCE, OAuth 1.0a, API key, basic auth, custom credentials)
- **Ephemeral execution** — Containers are created, run, and destroyed per execution
- **Sidecar isolation** — Credential injection via a sidecar proxy (agent never sees raw credentials)
- **Cron scheduling** — Schedule flows with cron expressions, distributed lock prevents duplicates
- **Marketplace** — Browse and install packages from the Appstrate Registry
- **Package import** — Import flows, skills, and extensions from ZIP files
- **Skills & extensions** — Extend agent capabilities with SKILL.md instructions and TypeScript tool extensions
- **Realtime** — SSE-based execution monitoring with LISTEN/NOTIFY
- **Multi-tenant** — Organization-based isolation with role-based access (owner/admin/member)
- **API keys** — Programmatic access via `ask_*` prefixed API keys
- **OpenAPI documentation** — 110 endpoints documented at `/api/openapi.json` + Swagger UI at `/api/docs`
- **Connection profiles** — Share connection sets across flows
- **Proxy system** — Org-level and flow-level outbound HTTP proxy support

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

# 4. Configure .env (copy .env.example, set LLM API keys + DB URL + Better Auth secret)

# 5. Build everything (shared-types + frontend)
bun run build                 # turbo build → apps/web/dist/

# 6. Start platform
bun run dev                   # turbo dev → Hono on :3010

# 7. First signup creates an organization automatically
```

## Project Structure

```
appstrate/
├── apps/
│   ├── api/src/              # Hono API server (:3010)
│   │   ├── routes/           # Route handlers (one file per domain)
│   │   ├── services/         # Business logic, Docker, adapters, scheduler, marketplace
│   │   ├── openapi/          # OpenAPI 3.1 spec (110 endpoints)
│   │   └── middleware/       # Auth, rate-limit, guards (requireAdmin, requireFlow)
│   │
│   └── web/src/              # React 19 SPA (Vite + React Query v5 + Zustand)
│       ├── pages/            # Route pages (React Router v7)
│       ├── hooks/            # React Query + SSE realtime hooks
│       ├── components/       # UI components (modals, forms, editors)
│       └── stores/           # Zustand stores (auth, org, profile)
│
├── packages/
│   ├── db/                   # @appstrate/db — Drizzle ORM (26 tables, 6 enums) + Better Auth
│   ├── env/                  # @appstrate/env — Zod env validation
│   ├── shared-types/         # @appstrate/shared-types — Drizzle InferSelectModel re-exports
│   ├── connect/              # @appstrate/connect — OAuth2/PKCE, API key, credential encryption
│   └── registry-client/      # @appstrate/registry-client — HTTP client for Appstrate Registry
│
├── data/                     # Built-in resources (loaded at boot)
│   ├── flows/{name}/         # manifest.json + prompt.md
│   ├── providers.json        # Service provider definitions
│   ├── skills/{id}/SKILL.md  # Agent skill instructions
│   └── extensions/{id}.ts    # Agent tool extensions
│
├── runtime-pi/               # Docker image: Pi Coding Agent SDK
│   ├── entrypoint.ts         # SDK session → JSON lines on stdout
│   └── sidecar/server.ts     # Credential-isolating HTTP proxy
│
└── scripts/verify-openapi.ts # OpenAPI validation (coverage + structure + lint)
```

**External dependency**: `@appstrate/validation` (`file:../validation`) — manifest schemas, naming helpers, dependency extraction, ZIP parsing.

## API Overview

The API is organized into 23 route domains with 110 documented endpoints:

| Domain | Description |
|--------|-------------|
| **Auth** | Better Auth email/password + cookie sessions |
| **Flows** | Flow CRUD, config, skills/extensions binding, versions |
| **Executions** | Run flows, list executions, logs, cancel |
| **Realtime** | SSE streams for execution monitoring |
| **Schedules** | Cron-based flow scheduling |
| **Connections** | OAuth2/API key service connections |
| **Connection Profiles** | Shared connection sets across flows |
| **Providers** | Service provider configuration |
| **Provider Templates** | Built-in provider templates |
| **Proxies** | Org-level and flow-level HTTP proxy config |
| **API Keys** | Programmatic access tokens (`ask_*`) |
| **Library** | Organization skills and extensions CRUD |
| **Marketplace** | Browse/install packages from Appstrate Registry |
| **Packages** | Import packages from ZIP files |
| **Notifications** | Execution notification management |
| **Organizations** | Org CRUD, members, invitations |
| **Profile** | User profile management |
| **Invitations** | Magic link invitation acceptance |
| **Share** | Public share tokens for one-time execution |
| **Welcome** | Post-invite profile setup |
| **Internal** | Container-to-host routes (credentials, execution history) |
| **Meta** | OpenAPI spec + Swagger UI |
| **Health** | Health check |

Full interactive docs: `GET /api/docs` (Swagger UI).

## Architecture

```
Browser (React SPA)              Platform (Bun + Hono :3010)
    |                                |
    |-- Login/Signup --------------->|-- Better Auth (cookie session)
    |-- POST /api/flows/:id/run --->|
    |                                |-- Validate → Create execution → Fire-and-forget
    |<-- SSE (realtime) ------------|-- LISTEN/NOTIFY → SSE stream
    |                                |
    |   Docker network (isolated):   |
    |   ┌─────────────────────┐      |
    |   │  Sidecar Container  │      │-- Credential injection proxy
    |   │  Agent Container    │      │-- Pi SDK → JSON lines stdout
    |   └─────────────────────┘      |
```

- **Sidecar pool**: Pre-warmed containers for fast startup
- **Parallel setup**: Sidecar + agent creation run concurrently
- **Credential isolation**: Agent calls sidecar proxy; never sees raw credentials
- **Output validation**: AJV validates output against schema with retry support

## Environment Variables

Key variables (see `.env.example` for full list):

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | Yes | — | Session signing secret |
| `CONNECTION_ENCRYPTION_KEY` | Yes | — | 32 bytes base64, encrypts stored credentials |
| `DATA_DIR` | No | unset | Path to `data/` dir (built-in flows/skills/extensions) |
| `LLM_PROVIDER` | No | `anthropic` | LLM provider for agent containers |
| `LLM_MODEL_ID` | No | `claude-sonnet-4-5-20250929` | Model ID for agent containers |
| `ANTHROPIC_API_KEY` | No | — | Passed to agent containers |
| `PORT` | No | `3010` | Server port |
| `APP_URL` | No | `http://localhost:3010` | Public URL for OAuth callbacks |
| `TRUSTED_ORIGINS` | No | `http://localhost:3010,http://localhost:5173` | CORS origins |
| `DOCKER_SOCKET` | No | `/var/run/docker.sock` | Docker socket path |
| `PROXY_URL` | No | — | Outbound HTTP proxy for sidecar containers |

## Development

```sh
bun run dev              # Start API + web (turbo)
bun run check            # TypeScript + ESLint + Prettier + OpenAPI validation
bun run verify:openapi   # OpenAPI spec validation only
bun run lint             # ESLint
bun run format           # Prettier
bun run db:generate      # Generate Drizzle migrations from schema
bun run db:migrate       # Apply migrations
bun run build            # Build everything (turbo)
bun run build-runtime    # Build agent Docker image
bun run build-sidecar    # Build sidecar Docker image
```

### Testing

```sh
cd apps/api
bun test                 # Full suite (requires PostgreSQL + Docker)
```

Tests use `bun:test` (built-in). Mocking pattern: `mock.module()` before dynamic `import()`.

## Tech Stack

- **Runtime**: Bun
- **API**: Hono (SSE, middleware, routing)
- **Database**: PostgreSQL 16 + Drizzle ORM
- **Auth**: Better Auth (cookie sessions) + API keys (`ask_*`)
- **Frontend**: React 19 + Vite + React Router v7 + React Query v5 + Zustand
- **Styling**: Single CSS file (dark theme, no Tailwind/CSS-in-JS)
- **i18n**: i18next (fr default, en)
- **Docker**: fetch() + unix socket (not dockerode)
- **Scheduling**: croner (in-memory cron with distributed lock)
- **Validation**: AJV (config/input/output), Zod (env), `@appstrate/validation` (manifests)
- **Build**: Turborepo + Bun workspaces
- **Code quality**: ESLint + Prettier + OpenAPI lint (`@redocly/openapi-core`)

## License

MIT
