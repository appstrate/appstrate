# Casing Conventions — Appstrate codebase

**Status**: authoritative reference. Audit via `/audit-casing` (see `.claude/commands/audit-casing.md`).

This document captures every casing decision made during the AFPS snake_case + DTO unification. Any code change MUST respect these rules. Deviations are bugs.

---

## TL;DR

| Surface                                                                  | Convention                                    | Example                                                     |
| ------------------------------------------------------------------------ | --------------------------------------------- | ----------------------------------------------------------- |
| Wire/JSON (HTTP responses, request bodies, AFPS manifests, OpenAPI)      | **snake_case**                                | `display_name`, `running_runs`, `cron_expression`           |
| Query-string parameters (same rule + carve-outs as wire JSON)            | **snake_case**                                | `actor_type`, `since`; carve-outs: `runId`, `startingAfter` |
| SQL columns                                                              | **snake_case**                                | `user_id`, `created_at`, `display_name`                     |
| Drizzle TS schema field names                                            | **camelCase** TS / **snake_case** SQL aliases | `userId: text("user_id")`                                   |
| TS internal (vars, function args, React props, Zustand state)            | **camelCase**                                 | `const userId = ...`                                        |
| Universal DB-convention fields (carve-out — stay camelCase EVERYWHERE)   | **camelCase**                                 | `id`, `createdAt`, `userId`, `packageId`                    |
| Better Auth tables + plugin tables (carve-out — HARD blocker)            | **camelCase** TS / **snake_case** SQL         | `user.emailVerified`                                        |
| Module hook contracts, logger fields, CloudEvents, Webhooks, BullMQ jobs | **camelCase**                                 | `logger.info({ runId })`                                    |
| JSONB internal `token_usage`                                             | **snake_case**                                | `{ input_tokens, output_tokens }` (SDK convention)          |
| JSONB internal `runs.metadata.creditsUsed`                               | **camelCase**                                 | (cloud's afterRun hook contract)                            |

When in doubt: **wire = snake_case, internal = camelCase**, with explicit carve-outs below.

---

## The 5 zones

### Zone 1 — Wire JSON (snake_case)

Everything that crosses HTTP in JSON or sits at rest in canonical formats.

**Concretely**:

- REST API response bodies (every field, every route)
- REST API request bodies (POST/PUT/PATCH inputs)
- AFPS manifest files (`manifest.json` inside packages)
- OpenAPI components (`apps/api/src/openapi/schemas.ts`, `paths/*.ts`)
- OAuth2 wire fields (RFC 6749: `client_id`, `redirect_uri`, `access_token`, etc.)
- SQL column names (via Drizzle `text("snake_name")` aliases)
- AFPS spec Zod schemas (`afps-spec/packages/schema/src/schemas.ts`)
- Appstrate validators (`packages/core/src/{validation,integration,mcp-server,form}.ts`)

**Sub-exception — `form.ts` RJSF vendor keys**: `mapAfpsToRjsf` in `packages/core/src/form.ts` reads canonical snake_case wrappers only (`file_constraints`, `ui_hints`, `property_order`, `max_size`); writeback is always snake_case. (The legacy camelCase reader fallback for older persisted manifests has been removed — the reader is now snake_case-only.) RJSF vendor-namespaced keys (`ui:order`, `ui:widget`, `ui:placeholder`) and RJSF widget options (`accept`, `maxSize`, `multiple`, `maxFiles`) are third-party APIs and intentionally camelCase — out of scope for Zone 1.

**Why snake_case** (SOTA evidence):

- Stripe, GitHub, AWS, OpenAI, Anthropic, Twilio, Slack: all use snake_case wire
- OAuth 2.0 RFC 6749 mandates snake_case
- PostgreSQL/MySQL/SQLite universal convention
- Cross-language friendly (Python, Ruby, Go consumers don't need translation)
- AFPS spec authoritative (our canonical source)

**Exception within Zone 1**: universal DB-convention field names stay camelCase on the wire (see Carve-out 2 below).

---

### Zone 2 — Drizzle TS schema (camelCase TS / snake_case SQL)

Every Drizzle `pgTable()` definition in `packages/db/src/schema/*.ts`.

**Pattern**:

```typescript
export const runs = pgTable("runs", {
  // ✅ Correct: camelCase TS field, snake_case SQL alias
  userId: text("user_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
  tokenUsage: jsonb("token_usage").$type<{ input_tokens?: number }>(),
});

// ❌ Wrong: snake_case TS field name
export const runs_wrong = pgTable("runs", {
  user_id: text("user_id"), // breaks Better Auth adapter expectations
});
```

**Why** (SOTA evidence):

| ORM      | Default convention                             |
| -------- | ---------------------------------------------- |
| Prisma   | `userId @map("user_id")` (recommended by docs) |
| Drizzle  | `userId: text("user_id")` (our pattern)        |
| TypeORM  | `@Column({ name: "user_id" }) userId`          |
| Kysely   | `CamelCasePlugin` auto-conversion              |
| MikroORM | `@Property({ fieldName: 'user_id' })`          |

→ 95%+ of TS ORM ecosystem uses this split.

**Why NOT snake_case TS Drizzle fields**:

- Better Auth's `drizzleAdapter` resolves model fields by TS property name. Snake_casing TS fields breaks BA at runtime ([Issue #1027](https://github.com/better-auth/better-auth/issues/1027), [#5649](https://github.com/better-auth/better-auth/issues/5649), [#5662](https://github.com/better-auth/better-auth/issues/5662) — all open/locked, not resolved)
- Drizzle Studio, drizzle-kit, all tooling assume camelCase TS
- Forking BA = bad idea; waiting for BA `casing: 'snake_case'` first-class option ([Issue #410](https://github.com/better-auth/better-auth/issues/410) since 2024, unresolved)
- Cost-benefit of flipping ~15,000 sites for zero user-visible payoff: declined

---

### Zone 3 — TS internal (camelCase)

Function arguments, local variables, React component props, Zustand state, internal type names, class properties.

**Examples**:

```typescript
// ✅ All correct camelCase
function getRun({ runId, packageId }) { ... }
const userName = profile.displayName;
const [selectedTab, setSelectedTab] = useState("overview");
<PackageCard runningRuns={count} displayName={pkg.display_name} />
```

**Why**: TC39 spec, TypeScript style guide, ESLint default `@typescript-eslint/naming-convention`, Prettier defaults, React convention.

---

### Zone 4 — Carve-outs (camelCase preserved with justification)

The exceptions to "wire = snake_case". Each has explicit documented reason.

#### Carve-out 4a — Better Auth managed tables (HARD framework blocker)

**Files**:

- `packages/db/src/auth.ts` (Better Auth config)
- `packages/db/src/schema/auth.ts` (BA core tables)
- `apps/api/src/modules/oidc/schema.ts` (BA plugin tables)

**Tables**: `user`, `session`, `account`, `verification`, plus OIDC plugin tables (`jwks`, `oauthClient`, `oauthAccessToken`, `oauthRefreshToken`, `oauthConsent`, `deviceCode`, `cliRefreshToken`).

**Rule**: every Drizzle TS field on these tables is **camelCase**. SQL columns can be snake_case via `text("col_name")` alias.

**Why**: Better Auth's `drizzleAdapter()` (in `packages/db/src/auth.ts:573`) resolves model fields by TS property name (`findOne({ model: "user", where: [{ field: "emailVerified" }] }`). Snake_casing crashes at runtime. Tracked: [BA #1027](https://github.com/better-auth/better-auth/issues/1027) (locked), [#5649](https://github.com/better-auth/better-auth/issues/5649), [#5662](https://github.com/better-auth/better-auth/issues/5662) (open).

**Workaround?** Theoretically yes via `fields: { emailVerified: "email_verified" }` mapping in BA config, BUT plugin ecosystem (SSO, organization, OIDC) doesn't reliably honor these mappings — 5+ open bugs. Not recommended.

#### Carve-out 4b — Universal DB-convention fields (stay camelCase EVERYWHERE)

These specific field names stay camelCase on **Drizzle, wire DTOs, OpenAPI, frontend reads** — same convention from SQL up to the JSON wire:

**Timestamps**: `createdAt`, `updatedAt`, `expiresAt`, `revokedAt`, `lastUsedAt`

**Universal FK to ubiquitous tables**: `id`, `userId`, `orgId`, `applicationId`, `packageId`, `endUserId`, `apiKeyId`, `scheduleId`, `modelCredentialId`

**Internal run carve-outs** (documented): `runNumber`, `runOrigin`, `contextSnapshot`

**Why**: These fields appear on dozens of types — flipping them cascades to ~15,000 sites cross-codebase + breaking change for all external API consumers, with zero user-visible benefit. The convention is universal across Drizzle/Prisma/TypeORM ecosystems (camelCase TS regardless of SQL casing).

**Domain timestamps DO flip** (do NOT include in this carve-out):

- `started_at`, `completed_at`, `last_run_at`, `next_run_at`, `connected_at`, `installed_at`

If unsure: "universal" means "appears on >5 different types". Otherwise snake_case.

#### Carve-out 4c — Profile/Member DTOs (Better Auth-derived)

`profile.displayName`, `member.displayName`, `OrganizationMember.*` stay camelCase. (`MeConnectionSourceGroup` is now integration-sourced and fully snake_case — no longer a profile-derived camelCase shape.)

**Why**: These shapes come from Better Auth's user/profile tables. Consuming as-is.

#### Carve-out 4d — Module hook contracts

**File**: `packages/core/src/module.ts`

**Interfaces**: `BeforeUsageParams`, `AfterRunResult`, `RunStatusChangeParams`, `OnOrgCreateParams`, `BeforeSignupContext`, `AfterSignupContext`, `RunConnectionMissingError`, `RunConnectionMissingParams`, `ModuleHooks`, `ModuleEvents`.

**Rule**: All fields camelCase TS.

**Why**: TS function-argument convention. Hook params are TS interfaces, not wire DTOs. Cloud's `afterRun` returns `{ creditsUsed }` (camelCase) — that's a TS contract, not a JSON wire field. The data ends up in `runs.metadata` JSONB as opaque storage.

#### Carve-out 4e — ModelProviderDefinition + provider DTOs

> **Vocabulary note**: "provider" here refers to **model providers** — Appstrate's internal LLM-credential registry (OpenAI, Anthropic, Codex, Claude Code, …). Not to be confused with the AFPS `provider` package type, which AFPS calls `integration`. Model providers are a distinct Appstrate subsystem with its own DTO surface.

**Files**:

- `apps/api/src/modules/core-providers/index.ts`
- `module-claude-code/src/index.ts`
- `module-codex/src/index.ts`
- `packages/shared-types/src/index.ts` (ProviderRegistryEntry, CatalogModelEntry, etc.)

**Rule**: `providerId`, `displayName`, `iconUrl`, `apiShape`, `defaultBaseUrl`, `baseUrlOverridable`, `authMode`, `featured`, `contextWindow`, `maxTokens`, `capabilities`, `cost` — all camelCase.

**Why**: Internal TS module contract for the provider registry. Not user-authored JSON. Camel/camel end-to-end (registry definition → API response → frontend read).

#### Carve-out 4f — Connect-helper / module-claude-code internal types

`ProviderLoopback.displayName`, `ModelProviderDefinition.displayName`, etc. — internal TS interfaces specific to these helper packages. Not user-facing wire format.

#### Carve-out 4g — JSONB internal contracts

| JSONB column                                                                                                                                                                                                | Interior casing                                                                                        | Why                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `runs.token_usage`                                                                                                                                                                                          | snake_case (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) | Anthropic/OpenAI SDK wire convention                          |
| `runs.metadata.creditsUsed`                                                                                                                                                                                 | camelCase                                                                                              | Cloud's `afterRun` hook contract; opaque storage of TS object |
| `runs.checkpoint`, `runs.config`, `runs.config_override`, `runs.input`, `runs.result`, `runs.connection_overrides`, `runs.inline_manifest`, `runs.context_snapshot`, `pinned`, `memory`, `webhooks.payload` | Opaque (varies by producer)                                                                            | Each producer documents its own shape                         |

**⚠️ Boundary — this carve-out covers JSONB that NEVER crosses the wire verbatim.** A JSONB column that is serialized back to a client as-is (no per-key projection) is a **wire payload**, not an internal contract, and its interior keys follow Zone 1 (**snake_case**, with the universal DB carve-out). The interior is the API contract.

| Wire-exposed JSONB column    | Interior casing                                         | Why                                                                                                                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organizations.org_settings` | **snake_case** (`api_version`, `dashboard_sso_enabled`) | Returned verbatim by `GET /api/orgs/:orgId/settings` and written verbatim by `PUT`; the blob IS the wire shape. Renaming a key here is a breaking wire change AND needs a JSONB data migration for existing rows (see `0002_rename_org_settings_keys.sql`). |

When adding a JSONB column, decide up front: **internal contract** (never returned raw → camelCase/producer-defined, this carve-out) or **wire-exposed** (returned/accepted raw → snake_case, Zone 1). If a route ever starts returning an internal blob verbatim, its keys must be migrated to snake_case.

#### Carve-out 4h — SSE event payloads (historical)

**File**: `apps/api/src/services/realtime.ts:27` (`snakeToCamel()` transform).

**Rule**: PG NOTIFY emits snake_case (matches SQL columns), realtime.ts converts to camelCase before SSE broadcast. Frontend reads camelCase from SSE.

**Channels (all snake→camel via the same transform)**:

- `run_update` — id, packageId, status, userId, endUserId, orgId, applicationId, scheduleId, error, startedAt, completedAt, duration.
- `run_log` — id, runId, orgId, applicationId, type, level, event, message, data, createdAt.
- `run_metric` — runId, orgId, applicationId, packageId, tokenUsage, costSoFar.
- `connection_update` — id, integrationPackageId, authKey, userId, endUserId, applicationId, needsReconnection, deleted, operation. Actor-scoped server-side via subscriber filter on `userId`/`endUserId` (drops cross-actor rows; cross-app already gated by upstream SSE auth).

**Why**: Historical. Not aligned with REST wire (snake_case + universal DB camelCase). Frontend components handle both shapes. Could be unified in future but not a bug.

#### Carve-out 4i — CloudEvents payloads

**File**: `packages/afps-runtime/src/types/canonical-events.ts`

**Rule**: All event payload fields camelCase (BaseEnvelope: `runId`, `toolCallId`, `timestamp`; payloads: `runnerKind`, `durationMs`, etc.).

**Why**: CloudEvents spec uses camelCase for context attributes; consistent producer/consumer.

#### Carve-out 4j — Webhook delivery payloads (Standard Webhooks spec)

**File**: `apps/api/src/modules/webhooks/service.ts`

**Rule**: Envelope (`id`, `object`, `type`, `apiVersion`, `created`, `data`) + inner payload all camelCase. Includes `packageId`, `resultTruncated`, `actor: { type, id }`, `errors: [{ field, code, message, title }]`.

#### Carve-out 4k — BullMQ job data

**Files**: `apps/api/src/services/scheduler.ts` (ScheduleJobData), `apps/api/src/modules/webhooks/service.ts` (DeliveryJobData).

**Rule**: All camelCase (`scheduleId`, `webhookId`, `eventId`, etc.). Opaque to consumers outside the queue layer.

#### Carve-out 4l — Logger fields (pino convention)

**Rule**: `logger.info({ runId, orgId, error })` — camelCase.

**Why**: pino style, indexable in Datadog/ELK/CloudWatch queries.

#### Carve-out 4m — Audit log JSONB payloads

**Rule**: `recordAuditFromContext({ after: { keyA, keyB } })` — camelCase explicit keys (NOT raw snake_case request body).

**Pattern**: when audit-logging an update, the route handler must map the snake_case request body to camelCase explicit keys:

```typescript
await recordAuditFromContext({
  action: "schedule.updated",
  after: {
    cronExpression: data.cron_expression,
    configOverride: data.config_override,
    // ... explicit camelCase keys, not the raw body
  },
});
```

Reason: SIEM queries (Datadog, Splunk) need stable field names, and all other audit sites already use camelCase explicit keys.

#### Carve-out 4n — Headless-platform DTO fields (camelCase end-to-end)

**Files**:

- `packages/shared-types/src/index.ts` (`ApiKeyInfo`, `ApplicationInfo`, `EndUserInfo`, `OrgProxyInfo`, `SocialProviderView`, `SmtpConfigView`, paginated list envelopes)
- `apps/api/src/openapi/schemas.ts` + `paths/{api-keys,applications,end-users,webhooks,oauth-clients,proxies,organizations}.ts`
- Webhook module CRUD surface (`apps/api/src/modules/webhooks/`)

**Rule**: a fixed set of headless-platform / developer-surface wire fields stays **camelCase** end-to-end (TS schema + service + OpenAPI + frontend hook all match):

- API key surface: `keyPrefix`
- Proxy surface: `urlPrefix`
- Application / end-user surface: `externalId`, `isDefault`, `allowedRedirectDomains`
- Pagination envelopes: `hasMore`
- Webhook CRUD surface: `payloadMode`, `eventId`, `eventType`, `statusCode`

**Why**: developer-platform surfaces modelled on the Stripe headless API convention (camelCase for developer-platform CRUD). End-to-end coherent (no impedance mismatch); flipping is a breaking change for external API consumers with zero user-visible benefit. Treat new fields on these specific surfaces the same way; for any new endpoint family, prefer snake_case wire per the Zone 1 default.

---

### Zone 5 — Asymétries documentées (historical inconsistencies, low-impact)

These are inconsistencies we know about and chose not to fix. Don't introduce new asymmetries; don't be surprised by these.

#### 5a — Env-vars JSON envelopes split convention

| Env var                   | JSON casing |
| ------------------------- | ----------- |
| `SYSTEM_PROVIDER_KEYS`    | camelCase   |
| `SYSTEM_PROXIES`          | camelCase   |
| `OIDC_INSTANCE_CLIENTS`   | camelCase   |
| `PLATFORM_RUN_LIMITS`     | snake_case  |
| `INLINE_RUN_LIMITS`       | snake_case  |
| `LLM_PROXY_LIMITS`        | snake_case  |
| `CREDENTIAL_PROXY_LIMITS` | snake_case  |

Historical split. Credentials/clients/proxies envelopes follow TS object convention (they map to TS types). Limit-config envelopes follow JSON wire convention.

#### 5b — SSE vs REST wire on the same logical entity

SSE Run payload is camelCase (per Carve-out 4h). REST Run payload mixes snake_case (domain) + camelCase (universal DB conv). Same logical Run object has two different field-name shapes depending on transport. Frontend handles both.

#### 5c — Model/proxy/credential ID wire on standalone vs override endpoints

**Standalone endpoints** (`/api/agents/:id/model`, `/api/agents/:id/proxy`, `/api/orgs/:id/models`) use **camelCase** wire fields: `modelId`, `proxyId`, `credentialId`.

**Schedule override endpoints** (`/api/schedules`, `/api/agents/:id/schedules`) use **snake_case** wire fields: `model_id_override`, `proxy_id_override`, `version_override`.

End-to-end consistent within each endpoint family (backend Zod ↔ OpenAPI ↔ frontend hook all match). The asymmetry is historical — the override fields followed AFPS snake_case canon while the standalone fields predate the migration. These IDs appear on 4 types each (≤5 threshold for Carve-out 4b), so they don't qualify as universal DB convention.

Don't introduce new endpoints in this surface; if a new model/proxy/credential endpoint is needed, prefer snake_case wire.

#### 5d — OAuth client management endpoints (Better Auth plugin pass-through)

`/api/oauth/clients/*` management routes (CRUD on the `oauthClient` BA plugin table) use **camelCase** wire: `redirectUris`, `postLogoutRedirectUris`, `isFirstParty`, `allowSignup`, `signupRole`, `referencedOrgId`, `referencedApplicationId`, `clientSecret`.

**Why**: these routes are CRUD pass-throughs on a Better Auth plugin-owned table. The wire shape mirrors the BA plugin's TS field names (Carve-out 4a chain). The actual OAuth 2.0 wire endpoints (`/oauth2/authorize`, `/oauth2/token`) correctly stay snake_case per RFC 6749 — only the management surface is camelCase.

Treat any new management-CRUD route on a BA plugin table the same way (mirror the plugin's TS field names). For non-plugin tables, the default snake_case wire rule still applies.

---

## Query-string parameters

Query params are wire surface. They follow the **same rule as wire JSON (Zone 1): snake_case by default**, with the same carve-outs applied by literal name:

- **Universal DB-convention names** (Carve-out 4b) stay camelCase — `id`-style references and `*At` timestamps from the exact Carve-out 4b list. In-tree examples: `?runId=`, `?orgId=`, `?applicationId=`.
- **Pagination-envelope params** stay camelCase, matching the Carve-out 4n envelope fields: the cursor params `startingAfter` / `endingBefore` pair with the camelCase `hasMore` body field — `GET /api/end-users` (`routes/end-users.ts`).
- **Headless-platform surface params** mirror their Carve-out 4n wire fields: `?externalId=` on `GET /api/end-users` matches the camelCase `externalId` DTO field.

Conforming snake_case examples: `?actor_type=&actor_id=` on the persistence routes (`routes/agents.ts:360`); OAuth 2.0 wire params `?client_id=`, `?post_logout_redirect_uri=` (RFC 6749, Zone 1). Single bare tokens (`limit`, `kind`, `status`, `q`, `since`) are trivially conforming.

A new camelCase domain query param is a bug, same as a camelCase domain wire field.

### Pagination styles (which one to use)

Three pagination idioms exist; choose by collection shape, never mix styles on one endpoint. All three emit RFC 5988 `Link` headers via `apps/api/src/lib/pagination-link.ts`:

| Style                 | Params                                            | Use for                                                           | Example                                                               |
| --------------------- | ------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| Cursor (Stripe-style) | `startingAfter` / `endingBefore` + `hasMore` body | Unbounded user-facing collections                                 | `GET /api/end-users` (`routes/end-users.ts`)                          |
| Offset                | `limit` + `offset`                                | Bounded admin lists                                               | `GET /api/runs` (`routes/runs.ts:204`); also notifications, schedules |
| Sequence cursor       | `since` (monotonic id)                            | Append-only log streams ONLY — doubles as the polling-tail cursor | `GET /api/runs/{id}/logs` (`routes/runs.ts:299`)                      |

---

## Package identifiers in URL paths

A package (`@scope/name`) appears in API paths in **two shapes**, by an explicit rule:

- **Single top-level package → `{scope}/{name}`** (two path params). Route pattern `/:scope{@[^/]+}/:name`. Used by agents, `packages/*` (registry tier), runs, schedules. ~34 routes.
- **Route references ≥2 packages → `{packageId}`** (one param holding `@scope/name`). Route pattern `/:packageId{@[^/]+/[^/]+}`. Used by `/api/integrations/*` (runtime tier), where routes like `/integrations/{packageId}/agent-resolution/{agentPackageId}` carry two packages in one path — two `{scope}/{name}` pairs would be ambiguous to parse. ~19 routes.

Both shapes resolve to the **same on-wire path** (`@foo/bar`); the difference is only how Hono splits it into params. So the choice is a route-authoring rule, not a wire-format difference.

**Encoding (the footgun):** naive `encodeURIComponent(packageId)` 404s **both** route shapes — it percent-encodes `@`→`%40` and `/`→`%2F`, which the route regexes reject. Consumers MUST use **`encodePackageIdPath(packageId)` from `@appstrate/core/naming`** — it validates the id and encodes each segment while keeping the `@`/`/` separators literal. Do not hand-roll a path encoder; do not call `encodeURIComponent` on the whole id.

```ts
import { encodePackageIdPath } from "@appstrate/core/naming";
api(`/integrations/${encodePackageIdPath(packageId)}/connections`);
```

This is the single canonical contract for frontend, SDK, github-action, and MCP consumers. (Filed as issue #609; the MCP server's prior client-side `encodePath` is superseded by this core helper.)

**Scope sigil in responses (issue #629):** any `scope`-bearing response field (`AgentListItem.scope`, `AgentDetail.scope`, runs `agent_scope`) emits the scope **with** the leading `@` (e.g. `"@myorg"`) — the same format the `{scope}` path params accept, so one operation's output is directly usable as the next operation's input.

---

## Field-name catalog (canonical)

### Manifest fields (AFPS — all snake_case)

**Common**: `name`, `version`, `type`, `display_name`, `description`, `keywords`, `license`, `repository`, `schema_version`, `dependencies`, `_meta`, `author`

**Dependencies subkeys**: `skills`, `mcp_servers`, `integrations`

**Agent extras**: `integrations_configuration`, `input`, `output`, `config`, `timeout`, `runtime_tools` (Appstrate extension), top-level `integrations.{id}.{tools, scopes}` (niveau-2 selection)

**Wrapper (input/output/config)**: `schema`, `file_constraints`, `ui_hints`, `property_order`

- `file_constraints.{key}`: `accept`, `max_size`
- `ui_hints.{key}`: `placeholder`

**MCP-server (MCPB)**: `manifest_version`, `server.{type, entry_point, mcp_config}`, `mcp_config.{command, args, env, platform_overrides}`, `tools[].{name, description}`, `user_config`, `_meta["dev.appstrate/mcp-server"].runtime` (Appstrate Bun override; per AFPS the mcp-server manifest is AFPS-native at the root — no `_meta["dev.afps/mcp-server"]` identity wrapper)

**Integration**:

- `source.kind`: `"local" | "remote" | "none"`
- `source.server.{name, version, vendored}`
- `source.remote.{url, transport}`
- `_meta["dev.appstrate/api"].auths.<key>.upload_protocols`
- `auths.{key}.{type, issuer, authorization_endpoint, token_endpoint, userinfo_endpoint, token_endpoint_auth_method, code_challenge_methods_supported, resource, authorization_params, default_scopes, scope_catalog, identity_claims, required_identity_claims, credentials, connect, delivery, authorized_uris, allow_all_uris}`
- `auths.{key}.connect.{login, tool, limits}`
- `auths.{key}.connect.login.{request, success_criteria, outputs, expires_in_output, identity_outputs}`
- `auths.{key}.connect.limits.{request_timeout_ms, max_response_bytes}`
- `auths.{key}.delivery.http.{in, name, prefix, value, encoding, allow_server_override}`
- `auths.{key}.delivery.env.{key}.{value, sensitive}`
- `auths.{key}.delivery.files.{key}.{value, mode}`
- `tools.{name}.{required_scopes}`
- `hidden_tools`
- `setup_guide.{callback_url_hint, steps[{label, url}]}`
- `icon`

### Wire DTO fields (apps/api responses)

**Mirror manifest** (snake_case on wire, projection from snake_case manifest):
`display_name`, `schema_version`

**Domain fields** (snake_case): `running_runs`, `used_by_agents`, `reused_by_agents`, `has_unarchived_changes`, `version_count`, `created_by_name`, `last_run`, `user_name`, `end_user_name`, `api_key_name`, `schedule_name`, `actor_name`, `actor_type`, `actor_id`, `manifest_name`, `latest_published_version`, `active_version`, `restored_version`, `total_connections`, `lock_version`, `auto_installed`, `agent_scope`, `agent_name`, `package_ephemeral`, `inline_manifest`, `inline_prompt`, `runner_name`, `runner_kind`, `config_override`, `model_label`, `proxy_label`, `version_label`, `model_source`, `version_dirty`, `token_usage`, `cron_expression`, `connection_overrides`, `last_run_at`, `next_run_at`, `model_id_override`, `proxy_id_override`, `version_override`, `artifact_size`, `yanked_reason`, `dist_tags`, `version_pin`, `draft_manifest`, `callback_url`, `source_code`, `started_at`, `completed_at`, `forked_from`

**Application-package DTO domain fields** (snake_case — `application_package` object on `/api/applications/{id}/packages*`): `version_id`, `installed_at`, `package_type`, `package_source` (also the PUT request body's `version_id`). Note `modelId`/`proxyId` on the same object stay camelCase per asymmetry 5c. `activated_at` (integration activate 201 response) follows the same domain-timestamp rule.

**Import-bundle response domain fields** (snake_case — `POST /api/packages/import-bundle` 201): `root_installed`, `root_package_id`, `root_version`, and per-item `imported[].version_id`.

**Integration DTO domain fields** (snake_case, post Phase 4): `scopes_granted`, `needs_reconnection`, `owner_type`, `owner_name`, `auth_key`, `account_id`, `shared_with_org`, `identity_claims`, `block_user_connections`, `has_oauth_client`, `has_client_secret`, `redirect_uri`, `missing_scopes`, `resolved_missing_scopes`, `resolved_owned_by_actor`, `org_default_enforced`, `can_add_connection`, `tool_catalog`, `required_scopes`, `source_id`, `source_type`, `client_id`, `client_secret`, `client_secret_hash`, `client_type`, `allowed_scopes`, `connected_at`, `force_account_select`, `connection_id`, `integration_package_id`, `agent_package_id`, `admin_pinned_connection_id`, `member_pinned_connection_id`, `org_default_connection_id`, `resolved_connection_id`, `owner_id`, `owner_user_id`, `owner_end_user_id`, `is_own`

**Internal sidecar↔platform wire fields** (snake_case, AFPS): the `/internal/integration-credentials/{scope}/{name}` GET + refresh endpoints emit all keys snake_case — `auth_key`, `auth_type`, `authorized_uris`, `scopes_granted`, `identity_claims`, `expires_at`, `delivery_plans`, `expires_at_epoch_ms`, and per-plan `header_name`, `header_prefix`, `allow_server_override`. The TS-internal source-of-truth type `IntegrationCredentialsWire` (in `@appstrate/connect/integration-credentials`) stays camelCase per the Zone 3 TS-internal convention; field-name translation happens at the JSON boundary via `serializeIntegrationCredentialsWire` (platform-side) and `normalizeIntegrationCredentialsWire` (sidecar-side). The legacy camelCase dual-emit was retired with AFPS — there is no carve-out for these endpoints. The RFC 8707 audience is emitted snake_case as `resource` only (no `audience` alias).

**Cloud billing wire**: `usage_percent`, `credits_used`, `credit_quota`, `period_end`, `cancel_at_period_end`, `plan_id`, `return_url`

**Universal DB convention** (camelCase carve-out on wire): `id`, `createdAt`, `updatedAt`, `expiresAt`, `revokedAt`, `lastUsedAt`, `runNumber`, `userId`, `orgId`, `applicationId`, `packageId`, `endUserId`, `apiKeyId`, `scheduleId`, `runOrigin`, `contextSnapshot`, `modelCredentialId`

**⚠️ The carve-out is this EXACT list — not a pattern.** Only the timestamp fields (`*At`) and id fields (`id`, `*Id`) above stay camelCase. Look-alikes that are NOT on the list are domain fields and go **snake_case on the wire**, even though they resemble a carve-out:

- `createdBy` → **`created_by`** (it is `*By`, an actor reference, not a timestamp/id; resembles `createdAt` but is NOT carved out).
- `createdByName` → **`created_by_name`** (already snake_case in the domain list above).

Rule of thumb: a field qualifies for the camelCase carve-out only if its literal name appears in the list above (universal DB convention) — never by suffix similarity.

---

## How to make a decision when adding a new field

1. **Is it a manifest field?** → snake_case (always, no exception).
2. **Is it a SQL column?** → snake_case (Drizzle SQL alias).
3. **Is it a Drizzle TS field?** → camelCase (matches SQL via `text("snake_alias")`).
4. **Is it a wire DTO field?**
   - On the universal DB carve-out list above? → camelCase
   - Otherwise → snake_case
5. **Is it a query-string parameter?** → same rule as the wire DTO: snake_case unless its literal name is on the universal DB carve-out list or it's a pagination param (see "Query-string parameters").
6. **Is it an OpenAPI component property?** → match the wire DTO (snake_case unless carve-out).
7. **Is it on a Better Auth-managed table?** → camelCase (TS), snake_case (SQL alias).
8. **Is it on a `ModelProviderDefinition` or provider DTO?** → camelCase (internal TS contract).
9. **Is it on a module hook params interface?** → camelCase (TS function-arg convention).
10. **Is it an internal TS variable, function arg, React prop, hook param?** → camelCase.
11. **Is it a logger field, BullMQ job key, CloudEvent payload, Webhook delivery payload?** → camelCase.
12. **Is it the interior of `runs.token_usage` JSONB?** → snake_case (SDK convention).
13. **Is it `runs.metadata.creditsUsed`?** → camelCase (cloud hook contract).
14. **Is it an audit log JSONB `after` payload?** → camelCase explicit keys (not raw snake_case body).
15. **Otherwise** → wire = snake_case, internal = camelCase. When ambiguous, **wire is the safer default for any external-facing surface**.

---

## SOTA evidence summary

| Surface                 | Our choice                               | SOTA reference                                                        |
| ----------------------- | ---------------------------------------- | --------------------------------------------------------------------- |
| Wire JSON               | snake_case                               | Stripe, GitHub, AWS, OpenAI, Anthropic, Twilio, Slack                 |
| OAuth 2.0 wire          | snake_case (`client_id`, `redirect_uri`) | RFC 6749 mandate                                                      |
| SQL columns             | snake_case                               | PostgreSQL/MySQL/SQLite universal                                     |
| Drizzle TS layer        | camelCase TS / snake_case SQL            | Prisma, Drizzle, TypeORM, Kysely, MikroORM (~95% of TS ORM ecosystem) |
| TS internal             | camelCase                                | TC39, ESLint default, Prettier, TypeScript style guide                |
| Better Auth integration | camelCase TS / snake_case SQL alias      | Better Auth official docs Option 4                                    |
| JSONB token usage       | snake_case (`input_tokens`)              | Anthropic + OpenAI SDK convention                                     |
| CloudEvents             | camelCase                                | CloudEvents spec                                                      |
| Logger fields           | camelCase                                | pino convention                                                       |

**Score: 10/10 conventions correctly aligned with SOTA.**

The only "compromise" non-SOTA-strict (universal DB fields stay camelCase on wire while domain fields are snake_case) is **forced by Better Auth blocker** — not arbitrary. Documented by 5+ open Better Auth GitHub issues since 2024.

---

## Decisions explicitly REJECTED

### Rejected — Full snake_case Drizzle TS schema fields

**Why considered**: aesthetic uniformity ("everything snake_case").
**Why rejected**: ~15,000 sites cross-codebase + Better Auth runtime crashes ([Issue #1027](https://github.com/better-auth/better-auth/issues/1027) etc.) + zero user-visible benefit + breaks ORM ecosystem convention.

### Rejected — Full camelCase wire DTOs

**Why considered**: minimize translation in TS frontend.
**Why rejected**: AFPS spec is snake_case (authoritative), OAuth2 RFC mandates snake_case, SQL columns are snake_case, all major multi-language APIs use snake_case wire.

### Rejected — Rename SQL columns

**Why considered**: never seriously.
**Why rejected**: zero user-visible value, real risk (migration + FK recreation + index recreation + downtime), SQL columns are already snake_case anyway.

### Rejected — `fields: { ... }` Better Auth mapping for snake_case TS

**Why considered**: theoretically allows snake_case TS with manual per-field mapping.
**Why rejected**: 5+ open Better Auth GitHub issues prove plugin ecosystem doesn't honor mappings reliably ([#410](https://github.com/better-auth/better-auth/issues/410), [#799](https://github.com/better-auth/better-auth/issues/799), [#1027](https://github.com/better-auth/better-auth/issues/1027), [#2175](https://github.com/better-auth/better-auth/issues/2175), [#5649](https://github.com/better-auth/better-auth/issues/5649), [#5662](https://github.com/better-auth/better-auth/issues/5662)). Fragile, breaks on every BA minor upgrade.

### Rejected — Fork Better Auth

**Why considered**: never seriously.
**Why rejected**: massive maintenance burden, ecosystem isolation.

### Rejected — Migrate away from Better Auth

**Why considered**: brief thought.
**Why rejected**: huge engineering work, BA is otherwise excellent, blocker is acceptable.

### Rejected — Normalize SSE to snake_case

**Why considered**: align with REST wire.
**Why rejected**: Historical, frontend handles both shapes, low impact, deferred.

### Rejected — Normalize env-vars JSON to single casing

**Why considered**: split between camelCase (credentials) and snake_case (limits).
**Why rejected**: Both shapes work, low impact, breaking change for operators with existing env files.

---

## Verification commands

### Find camelCase wire-DTO leaks (should be snake_case)

```bash
cd /Users/pierrecabriere/Dev/appstrate/appstrate

# Domain fields that should be snake_case but appear as camelCase
rg "(\.|:\s+)(displayName|schemaVersion|forkedFrom|runningRuns|usedByAgents|reusedByAgents|hasUnarchivedChanges|versionCount|createdByName|lastRun|userName|endUserName|apiKeyName|scheduleName|actorName|actorType|actorId|manifestName|latestPublishedVersion|activeVersion|restoredVersion|totalConnections|lockVersion|autoInstalled|agentScope|agentName|packageEphemeral|inlineManifest|inlinePrompt|runnerName|runnerKind|configOverride|modelLabel|proxyLabel|versionLabel|modelSource|versionDirty|tokenUsage|cronExpression|connectionOverrides|lastRunAt|nextRunAt|modelIdOverride|proxyIdOverride|versionOverride|artifactSize|yankedReason|distTags|versionPin|draftManifest|callbackUrl|sourceCode)\b" -t ts -t tsx
```

### Find snake_case in places that should be camelCase

```bash
# Universal DB convention should stay camelCase
rg "(\.|:\s+)(created_at|updated_at|user_id|org_id|application_id|package_id|end_user_id|api_key_id|schedule_id|expires_at|revoked_at|last_used_at|run_number|run_origin|context_snapshot|model_credential_id)\b" -t ts -t tsx
```

### Find Drizzle pgTable with snake_case TS fields (bug)

```bash
rg "pgTable\(" packages/db/src/schema/ -A 30 | rg "^\s+[a-z]+_[a-z_]+:"
```

### Verify Better Auth tables stay camelCase

```bash
rg "(user|session|account|verification)\.(email_verified|user_id|provider_id|account_id|provider_account_id|access_token|refresh_token|password_hash)" -t ts
```

### Run full automated audit

```bash
# In Claude Code:
/audit-casing
```

The `/audit-casing` skill dispatches parallel opus sub-agents to verify every dimension against this document and reports any deviation.

---

## Related files

- `/Users/pierrecabriere/Dev/appstrate/appstrate/CLAUDE.md` — references this doc
- `/Users/pierrecabriere/Dev/appstrate/CLAUDE.md` — workspace root, references this doc
- `/Users/pierrecabriere/Dev/appstrate/appstrate/.claude/commands/audit-casing.md` — automated audit skill
- `/Users/pierrecabriere/Dev/appstrate/afps-spec/spec.md` — AFPS canonical spec (snake_case authority)
- `/Users/pierrecabriere/Dev/appstrate/appstrate/packages/core/src/validation.ts` — appstrate Zod validators
- `/Users/pierrecabriere/Dev/appstrate/appstrate/packages/shared-types/src/index.ts` — wire DTO type definitions
- `/Users/pierrecabriere/Dev/appstrate/appstrate/apps/api/src/openapi/schemas.ts` — OpenAPI components

---

## Migration history

| Phase         | Commit                 | Scope                                                              |
| ------------- | ---------------------- | ------------------------------------------------------------------ |
| Pass 1        | (many)                 | AFPS manifest field renames (snake_case)                           |
| Pass 2        | (many)                 | Fix readers/writers that missed Pass 1                             |
| Phase 1       | `79bb77f5`             | DTO mirror fields: `display_name`, `schema_version`, `forked_from` |
| Phase 2       | `009ae169`             | ~30 DTO domain fields (agent/skill/run/schedule)                   |
| Phase 3 cloud | `bf257538` + `88c8ba1` | Cloud billing DTOs                                                 |
| Phase 4       | `9c28f946`             | Integration DTOs (12 interfaces)                                   |
| F1            | `7b5665d7`             | UI prop mismatches + e2e seed + audit log shape                    |
| F2            | `fb81095b`             | OpenAPI contract drift (Run/Schedule/AgentDetail)                  |
| F4            | `9400e897`             | Doc drift (JSDoc + CLAUDE.md)                                      |
| Micro-drift   | `c5cd8add`             | `is_own`, ValidationFieldError extras, missing_scopes prop         |

Adjacent commits: `3d230fbc` (shared-types signature), `23fed6ad` (briefing-agent example), `3f78f136` (test fixtures), `591807846` (OpenAPI v2 + SQL JSONB), `bf257538` (web cloud billing consume).
