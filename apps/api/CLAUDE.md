# Backend (`@appstrate/api`)

Conventions for `apps/api`. Root guide: `../../CLAUDE.md`. Module authoring: `src/modules/README.md`.

- **Multi-tenant**: all DB queries filter by `orgId`. Space-scoped resources (agents, runs, schedules, webhooks, connections, end-users, api-keys, notifications, packages) also filter by `spaceId`. Admins = org role `admin`/`owner`.
- **Service layer**: function-based (no classes). `services/state/` (runs, notifications, package-persistence) is the central data-access layer. Drizzle via `import { db } from "@appstrate/db/client"` + schema from `@appstrate/db/schema`.
- **Request pipeline** (`index.ts`): error handler → Request-Id → client-IP (`TRUST_PROXY`) → CORS → bodyLimit → health (`/`) → OpenAPI docs → `/llms.txt` → shutdown gate → `/api/auth/bootstrap` → Better Auth (`/api/auth/*`) → auth middleware (custom strategies → API key `ask_` → cookie → `Appstrate-User`) → **realm guard** (`requirePlatformRealm` — rejects OIDC end-user sessions on platform routes) → org context (`X-Org-Id`) → permission resolution → space context (`X-Space-Id`, required for space-scoped routes) → API version (`Appstrate-Version`) → route handler (per-route `rateLimit()`/`idempotency()`) → cloud routes (if loaded).
- **Platform config**: `buildAppConfig()` computed once at boot, serialized as `window.__APP_CONFIG__`, injected into `index.html` at serve time. `googleAuth`/`githubAuth`/`smtp` derived from env presence.
- **External modules**: appended npm specifiers to `MODULES`. Declared-but-not-installed = boot crash.
- **Cost tracking**: `runs.cost` (doublePrecision) = sum of `llm_usage` ledger via `computeRunSpend(runId, orgId)` (`services/state/runs.ts`, single read path). Ingestion paths + precision trade-off: `docs/architecture/RUN_COST.md`.
- **Hono context** (`c.get`): `user`, `orgId`, `orgRole`, `orgSlug`, `permissions`, `authMethod`, `apiKeyId`, `spaceId`, `space`, `endUser`, `apiVersion`, `package` (set by `requireAgent` — NOT `agent`), `run`, `requestId`, `sessionRealm`.
- **Route guards** (`middleware/guards.ts`): `requireAgent()` (no arg — reads `:scope`/`:name`, loads package, sets `c.set("package")`), `requireOrgAgent()`, `requirePackageInOrg()` (gates package mutation on DB `orgId` ownership — NOT scope identity; a foreign-scope package the org owns is freely mutable), `requireMutableAgent()` (403 system package, 409 running runs), `apiKeyOrgScopeGuard()`/`apiKeySpaceScopeGuard()` (stop an API key escaping its org/space via path params). RBAC is `requirePermission(resource, action)` (`middleware/require-permission.ts`) — there is **no** `requireAdmin()`/`requireOwner()`. `requireSpaceContext()` (`middleware/space-context.ts`) validates `X-Space-Id` (or the API key's own `spaceId`) + space∈org.
- **Rate limiting**: Redis-backed `rate-limiter-flexible`. Keyed `method:path:identity` (`userId` / `apikey:{id}`), IP-based for public routes. IETF `RateLimit` headers. Key limits: run 20/min, import 10/min, schedule-create 10/min, run logs 120/min.
- **Route registration order**: `userAgentsRouter` MUST register before `agentsRouter` in `index.ts` — Hono matches in order.
- **Docker streams**: multiplexed 8-byte frame headers `[stream_type(1), 0(3), size(4)]` parsed in `streamLogs()`.
- **Package versioning**: semver across `package-versions.ts`, `package-version-deps.ts`, `package-storage.ts`. Tables: `packageVersions`, `packageDistTags`, `packageVersionDependencies`. Enforcement via `@appstrate/core/version-policy` (`validateForwardVersion` — forward-only). Resolution: exact → dist-tag → semver range (`resolveVersionFromCatalog`). Integrity: SHA256 SRI via `@appstrate/core/integrity`.
- **Package types**: `agent`, `skill`, `mcp-server`, `integration`. System tools (`output`/`log`/`note`/`pin`/`publish_file`) are transport-neutral MCP definitions in `packages/core/src/runtime-tool-defs.ts` (served sidecar-side), opt-in per agent via manifest `runtime_tools: string[]` (catalog `@appstrate/core/runtime-tools-catalog`). `output` required only when agent declares `output.schema` (enforced by `agentManifestSchema` superRefine). Outbound third-party API access flows exclusively through **integrations**.
- **System agents**: all agents (system + local) live in DB. System agents loaded from `system-packages/` ZIPs at boot and synced with `orgId: null` (`lib/boot.ts` `syncSystemPackagesToDb()`).
- **Graceful shutdown**: `run-tracker.ts` — stop scheduler → reject new POST → wait in-flight (max 30s) → exit.
- **Validation (Zod)**: all route bodies validated with `parseBody(schema, body)` from `lib/errors.ts` (`.safeParse()` → throws `invalidRequest()`). Naming `{concept}Schema` / `{Concept}` (`z.infer`). JSONB reads use safe narrowing (null/typeof/Array.isArray), not raw `as`. Query params: `z.coerce.number().int().min().max().catch(default).parse()`. **Zod 4** — `z.url()` NOT `z.string().url()`, `z.uuid()`. Reference: `routes/models.ts`, `routes/webhooks.ts`, `routes/organizations.ts`.
- **Validation (AJV)**: `validateAgainstSchema()`/`validateInput()`/`validateOutput()` for **dynamic** manifest schemas only. One AJV instance, `coerceTypes: true`, extra fields allowed.

## Headless Developer Platform

Headless API for embedding agents. Patterns mirror Stripe.

- **Spaces** (`spaces`, prefix `spc_`): each org has a default (`isDefault: true`). API keys scoped to a space. Routes `/api/spaces` (CRUD, admin).
- **End-users** (`end_users`, prefix `eu_`): external users via API, belong to a space. Not Better Auth users. Routes `/api/end-users` (CRUD, admin). Fields: `externalId` (unique/space), `metadata` (JSONB ≤50 keys), `email`, `name`. Default connection profile on creation.
- **`Appstrate-User` header**: impersonation (`eu_` ID). API key auth only — `400` on cookie. Validates end-user belongs to the key's space. Full audit log per impersonation.
- **Webhooks** (`webhooks` prefix `wh_`, `webhook_deliveries`): space-scoped (`spaceId` NOT NULL). Standard Webhooks spec (HMAC-SHA256). BullMQ delivery, 8-attempt backoff. Events: `run.started`/`success`/`failed`/`timeout`/`cancelled`. SSRF protection on URLs. Routes `/api/webhooks` (CRUD + test/ping + rotate + deliveries, admin).
- **Space packages** (`space_packages`): installed packages per space with the agent's stored input settings (`input_settings` jsonb — `{ values, locked }`, read via `getInstalledPackageSettings()`, written only by `PUT /api/agents/{scope}/{name}/input-settings`), model/proxy overrides, and version pinning. All of it is per-space (not per-org).
- **API versioning**: date-based. Header `Appstrate-Version` (request override + response). Org pinning via `settings.apiVersion`. `Sunset` header on deprecated. `middleware/api-version.ts`.
- **Idempotency**: `Idempotency-Key` on POST routes. Redis-backed, 24h TTL, SHA-256 body hash. `409` concurrent, `422` body mismatch, `Idempotent-Replayed: true` on cached replay. `middleware/idempotency.ts`.
- **Error handling**: RFC 9457 `application/problem+json` on all endpoints. `ApiError` factories (`invalidRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict`, `gone`, `internalError`, `systemEntityForbidden`). `Request-Id` (`req_`) on all responses.
- **SSE + API key**: SSE endpoints accept `?token=ask_...` query param (EventSource can't send headers). Cookie fallback preserved.

## API Reference

**OpenAPI 3.1 spec is the single source of truth for all API endpoints** (request/response schemas, auth, errors, SSE formats).

- **Source**: `src/openapi/` — modular TS files assembled at build time. Module endpoints contribute via `AppstrateModule.openApiPaths()`.
- **Live spec**: `GET /api/openapi.json` (public). **Docs**: `GET /api/docs` (Swagger UI, public).
- **Validation**: `bun run verify:openapi` — coverage, structural, lint, Zod↔spec bodies, Code ⊆ Spec static analysis (ADR-004).

When working on routes, consult the corresponding file in `src/openapi/paths/`.
