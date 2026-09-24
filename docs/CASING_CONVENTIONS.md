# Casing Conventions — Appstrate codebase

**Status**: authoritative reference. Enforced by the gates listed under [Enforcement](#enforcement); audited in depth by `/audit-casing` (see `.claude/commands/audit-casing.md`).

Every casing rule of the codebase is stated here. Any code change MUST respect these rules. Deviations are bugs. A new camelCase wire name is a new exception: it is added to this document and to the OpenAPI gate's allowlist in the same change, or not at all.

---

## TL;DR

| Surface                                                                                    | Convention                                    | Example                                                     |
| ------------------------------------------------------------------------------------------ | --------------------------------------------- | ----------------------------------------------------------- |
| Wire/JSON (HTTP responses, request bodies, AFPS manifests, OpenAPI)                        | **snake_case**                                | `display_name`, `running_runs`, `cron_expression`           |
| Query-string parameters (same rule + carve-outs as wire JSON)                              | **snake_case**                                | `actor_type`, `since`; carve-outs: `runId`, `startingAfter` |
| Error bodies (RFC 9457 problem documents)                                                  | **snake_case** extension members              | `request_id`, `retry_after`, `errors[].field`               |
| JSONB returned verbatim on the wire (platform-written)                                     | **snake_case** interior                       | `org_settings`, `runs.metadata`, `generation_config`        |
| SQL identifiers (tables, columns, indexes, constraints)                                    | **snake_case**                                | `user_id`, `created_at`, `idx_spaces_one_default`           |
| Drizzle TS schema field names                                                              | **camelCase** TS / **snake_case** SQL aliases | `userId: text("user_id")`                                   |
| TS internal (vars, function args, React props, Zustand state)                              | **camelCase**                                 | `const userId = ...`                                        |
| Universal DB-convention fields (carve-out 4b — stay camelCase EVERYWHERE)                  | **camelCase**                                 | `id`, `createdAt`, `userId`, `packageId`, `runId`           |
| Named wire carve-outs (4c, 4e, 4n; asymmetries 5c, 5d) — by literal name (5d: per surface) | **camelCase**                                 | `displayName`, `providerId`, `hasMore`, `modelId`           |
| Better Auth tables + plugin tables (carve-out — HARD blocker)                              | **camelCase** TS / **snake_case** SQL         | `user.emailVerified`                                        |
| Module hooks, logger fields, run events, webhook deliveries, BullMQ jobs, audit payloads   | **camelCase**                                 | `logger.info({ runId })`                                    |
| Agent tool arguments, AFPS bundle container, runner/sidecar boot contracts                 | **camelCase**                                 | `fromFile`, `bundleFormatVersion`, `pinnedSlots`            |
| JSONB `token_usage`                                                                        | **snake_case**                                | `{ input_tokens, output_tokens }` (SDK convention)          |

When in doubt: **wire = snake_case, internal = camelCase**. A camelCase name on the wire is legal only when its literal name is on a carve-out list below.

---

## The 5 zones

### Zone 1 — Wire JSON (snake_case)

Everything that crosses HTTP in JSON or sits at rest in canonical formats.

**Concretely**:

- REST API response bodies (every field, every route)
- REST API request bodies (POST/PUT/PATCH inputs)
- Query-string parameters (see [Query-string parameters](#query-string-parameters))
- Error bodies (see [Error bodies](#error-bodies-rfc-9457))
- JSONB columns a route returns or accepts verbatim (see the boundary rule of carve-out 4g)
- AFPS manifest files (`manifest.json` inside packages)
- OpenAPI components (`apps/api/src/openapi/schemas.ts`, `paths/*.ts`, every module's OpenAPI contribution)
- OAuth2 wire fields (RFC 6749: `client_id`, `redirect_uri`, `access_token`, `refresh_token`, etc.)
- SQL identifiers (via Drizzle `text("snake_name")` aliases and explicit constraint names)
- AFPS spec Zod schemas (`afps-spec/packages/schema/src/schemas.ts`)
- Appstrate validators (`packages/core/src/{validation,integration,mcp-server,form}.ts`)

**Sub-exception — `form.ts` RJSF vendor keys**: `mapAfpsToRjsf` in `packages/core/src/form.ts` reads the canonical snake_case wrappers only (`file_constraints`, `ui_hints`, `property_order`, `max_size`); writeback is always snake_case. RJSF vendor-namespaced keys (`ui:order`, `ui:widget`, `ui:placeholder`) and RJSF widget options (`accept`, `maxSize`, `multiple`, `maxFiles`) are third-party APIs and intentionally camelCase — out of scope for Zone 1.

**Why snake_case** (SOTA evidence):

- Stripe, GitHub, AWS, OpenAI, Anthropic, Twilio, Slack: all use snake_case wire
- OAuth 2.0 RFC 6749 mandates snake_case
- PostgreSQL/MySQL/SQLite universal convention
- Cross-language friendly (Python, Ruby, Go consumers don't need translation)
- AFPS spec authoritative (our canonical source)

**Exception within Zone 1**: the carve-out names of Zone 4 and the asymmetries of Zone 5 stay camelCase on the wire, each by its literal name — the 5d names only on their own surfaces.

#### Error bodies (RFC 9457)

Every error response is an `application/problem+json` document, and every one is built in one place: `ApiError.toProblemDetail` (`packages/core/src/api-errors.ts`, type `ProblemDetail`). Standard members: `type`, `title`, `status`, `detail`, `instance`. Extension members follow Zone 1: `code`, `param`, `request_id`, `retry_after`, and `errors[]` entries (`ValidationFieldError`: `field`, `code`, `message`, `title`). Connection-resolution errors add snake_case extras on those entries (`ResolutionFieldError`: `candidate_connections`, `connection_id`, `missing_scopes`, `required_scopes`, …). A carve-out name inside an error keeps its carve-out spelling (a connect offer's `expiresAt`, `packageId`).

HTTP headers are field names, not JSON, and keep their HTTP spelling: `Request-Id`, `Retry-After`.

---

### Zone 2 — Drizzle TS schema (camelCase TS / snake_case SQL)

Every Drizzle `pgTable()` definition:

- `packages/db/src/schema/*.ts` — the whole platform schema, including the tables built-in modules read and write
- `packages/module-ee/drizzle/schema.ts` — `@appstrate/module-ee`'s `ee_*` tables, migrated under its own journal (`drizzle.ee_migrations`) into the platform database

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

Every SQL identifier the schema names — table, column, index, foreign key, unique constraint, primary key, check — is snake_case. Both schemas are held to this by the Drizzle schema casing tests (see [Enforcement](#enforcement)).

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

A TS type that mirrors a wire object keeps the wire's names (a `RunWireDto` field is `started_at`); a TS type of its own is camelCase, and the translation happens at the JSON boundary.

**Why**: TC39 spec, TypeScript style guide, ESLint default `@typescript-eslint/naming-convention`, Prettier defaults, React convention.

---

### Zone 4 — Carve-outs (camelCase preserved with justification)

The exceptions to "wire = snake_case" and the non-wire surfaces that follow the TS convention. Each has an explicit documented reason.

#### Carve-out 4a — Better Auth managed tables (HARD framework blocker)

**Files**:

- `packages/db/src/auth.ts` — `buildAuth` passes the whole schema barrel to `drizzleAdapter(db, { provider: "pg", schema })`
- `packages/db/src/schema/auth.ts` — BA core tables
- `packages/db/src/schema/oidc.ts` — BA plugin tables and the platform's OIDC tables

**Tables**:

- BA core: `user`, `session`, `account`, `verification`.
- BA plugin models (`jwt`, `@better-auth/oauth-provider`, device authorization): `jwks`, `deviceCode`, `oauthClient`, `oauthAccessToken`, `oauthRefreshToken`, `oauthConsent`, `oauthResource`, `oauthClientResource`, `oauthClientAssertion`. The adapter addresses a table by its **export key** and a column by its **property name**; renaming either breaks the mapping, and from Better Auth 1.7.3 a field the plugin writes with no matching property raises `SchemaMismatchError` at boot.
- `cliRefreshToken` — the CLI refresh-token table behind the `appstrate-cli-token` plugin (`apps/api/src/modules/oidc/auth/cli-plugin.ts`, `services/cli-tokens.ts`). Same naming, and its management surface mirrors it (5d).

**Platform-owned tables in the same file** (NOT Better Auth models): `oidcEndUserProfiles`, `spaceSmtpConfigs`, `spaceSocialProviders`. They are ordinary Zone 2 tables, and their management routes are ordinary Zone 1 wire: SMTP config `from_address`, `from_name`, `secure_mode` (the test-send response returns `message_id`); social provider `client_id`, `client_secret`. Wire types: `SmtpConfigView`, `SocialProviderView` in `packages/shared-types/src/oidc.ts`.

**Rule**: every Drizzle TS field on the BA tables is **camelCase**, and the TS names are never renamed or remapped. SQL columns are snake_case via `text("col_name")` aliases.

**Why**: Better Auth's adapter resolves model fields by TS property name (`findOne({ model: "user", where: [{ field: "emailVerified" }] }`). Snake_casing crashes at runtime. Tracked: [BA #1027](https://github.com/better-auth/better-auth/issues/1027) (locked), [#5649](https://github.com/better-auth/better-auth/issues/5649), [#5662](https://github.com/better-auth/better-auth/issues/5662) (open).

**Workaround?** Theoretically yes via `fields: { emailVerified: "email_verified" }` mapping in BA config, BUT plugin ecosystem (SSO, organization, OIDC) doesn't reliably honor these mappings — 5+ open bugs. Not recommended.

Built-in modules own no tables: the tables they read and write live in `packages/db/src/schema/` (`apps/api/src/modules/README.md` § "Database ownership rules"). `@appstrate/module-ee` is the one module with a schema of its own (`packages/module-ee/drizzle/schema.ts`); Zone 2 applies to it unchanged.

#### Carve-out 4b — Universal DB-convention fields (stay camelCase EVERYWHERE)

These specific field names stay camelCase on **Drizzle, wire DTOs, OpenAPI, query strings, frontend reads** — same convention from SQL up to the JSON wire:

**Timestamps**: `createdAt`, `updatedAt`, `expiresAt`, `revokedAt`, `lastUsedAt`

**Universal FK to ubiquitous tables**: `id`, `userId`, `orgId`, `spaceId`, `packageId`, `runId`, `endUserId`, `apiKeyId`, `scheduleId`, `modelCredentialId`

**Run fields**: `runNumber`, `runOrigin`, `contextSnapshot`

**Why**: These fields appear on dozens of types — flipping them cascades to ~15,000 sites cross-codebase + breaking change for all external API consumers, with zero user-visible benefit. The convention is universal across Drizzle/Prisma/TypeORM ecosystems (camelCase TS regardless of SQL casing).

**Domain timestamps DO flip** (NOT in this carve-out): `started_at`, `completed_at`, `last_run_at`, `next_run_at`, `connected_at`, `installed_at`, `consumed_at`, `read_at`, `deleting_at`.

**The list is exact, not a pattern.** A name qualifies only by its literal spelling; a look-alike (`createdBy`, `homeSpaceId`, `integrationId`) is a domain field and goes snake_case. "Universal" means "appears on more than five different types"; a name joins the list only by an edit to this section and to the OpenAPI gate, never by resemblance. The enumerated snake_case counter-exceptions are listed under [Universal DB convention](#universal-db-convention-carve-out-4b-on-the-wire) in the catalog.

#### Carve-out 4c — Profile/Member DTOs

The profile/member family stays camelCase as a fixed set of names:

- `UserProfile.displayName` (`GET`/`PATCH /api/profile`), `ProfileBatchItem.displayName`
- `OrgMember.{userId, displayName, joinedAt}`
- `POST /api/profile/password` body `newPassword`

**Why**: `profiles` is a platform table (`packages/db/src/schema/profiles.ts`) keyed 1:1 on Better Auth's `user.id`; these DTOs join it with the BA `user` row and are read by the dashboard next to Better Auth's own camelCase session payloads. `newPassword` is forwarded unchanged as the body of Better Auth's `setPassword`. Any OTHER field added to these DTOs follows Zone 1.

#### Carve-out 4d — Module hook contracts

**File**: `packages/core/src/module.ts`

**Types**: `ModuleHooks` (= `FirstMatchHooks` + `BroadcastHooks`), `ModuleEvents`, `BeforeUsageParams`, `UsageRejection`, `BeforeSignupContext`, `AfterSignupContext`, `RunStatusChangeParams`, `RunConnectionMissingParams`, `ModuleOrgMember`, `ModuleInitContext`, `PlatformServices`, `LlmUsageLedgerRow`. Events without a params object take positional arguments (`onOrgCreate(orgId, userEmail)`, `onOrgDelete(orgId)`, `onOrgMemberRemove(orgId, userId)`).

**Rule**: All fields camelCase TS.

**Why**: TS function-argument convention. Hook params are TS interfaces, not wire DTOs. Fields like `BeforeUsageParams.runningCount` or `RunStatusChangeParams.modelSource` are camelCase — TS contracts, not JSON wire fields. A wire value carried through a hook keeps its own interior casing (`RunConnectionMissingParams.errors` are `ValidationFieldError`s).

#### Carve-out 4e — Model-provider names

> **Vocabulary note**: "provider" here refers to **model providers** — Appstrate's LLM-credential registry (OpenAI, Anthropic, Codex, Claude Code, …). Not to be confused with the AFPS `provider` package type, which AFPS calls `integration`.

**Files**:

- `packages/core/src/module.ts` (`ModelProviderDefinition`, `ModelCost`)
- `apps/api/src/modules/core-providers/index.ts`
- `packages/module-claude-code/src/index.ts`
- `packages/module-codex/src/index.ts`
- `packages/shared-types/src/index.ts` (`ProviderRegistryEntry`, `ProviderRegistryModelEntry`, `CatalogModelEntry`, `ModelProviderCredentialInfo`, `OrgModelInfo`)

**Rule — name-based**: these names stay camelCase **wherever they appear** in the model-provider family (credentials, org models, OAuth pairing, provider registry): `providerId`, `apiShape`, `authMode`, `displayName`, `iconUrl`, `defaultBaseUrl`, `baseUrlOverridable`, `featured`, `contextWindow`, `maxTokens`, `capabilities`, `cost` (with `cost.{input, output, cacheRead, cacheWrite}`), `docsUrl`. Every OTHER field of these objects is Zone 1 (`api_key`, `base_url`, `base_url_override`, `provider_name`, `available_model_ids`, `access_token`, `refresh_token`, `account_id`, `consumed_at`, `model_ids`, `promoted_default`, …), except the 4b names and the 5c ids (`modelId`, `credentialId`). A nested object that is not a 4e name is Zone 1 all the way down: `generation.reasoning.{temperature_compatible, native_levels}`.

| Body / object                                                  | camelCase (carve-out)                                                                                                            | snake_case / single word                                                                                                                                           |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/model-provider-credentials` body                    | `providerId` (4e)                                                                                                                | `label`, `api_key`, `base_url_override`                                                                                                                            |
| `PATCH /api/model-provider-credentials/{id}` body              | —                                                                                                                                | `label`, `api_key`                                                                                                                                                 |
| `POST /api/model-provider-credentials/test` body               | `apiShape` (4e)                                                                                                                  | `base_url`, `api_key`, `existing_key_id`                                                                                                                           |
| `POST /api/model-provider-credentials/discover` body           | `providerId` (4e), `credentialId` (5c)                                                                                           | `api_key`, `base_url_override`                                                                                                                                     |
| `ModelProviderCredential`                                      | `id`, `apiShape`, `authMode`, `providerId`, `createdAt`, `updatedAt`                                                             | `label`, `base_url`, `source`, `oauth_email`, `needs_reconnection`, `available_model_ids`, `created_by`                                                            |
| `POST /api/model-provider-credentials/{id}/refresh-models` 200 | —                                                                                                                                | `outcome`, `candidate_count`, `available_model_ids`                                                                                                                |
| `OrgModel`                                                     | `id`, `apiShape`, `providerId`, `modelId`/`credentialId` (5c), `contextWindow`, `maxTokens`, `iconUrl`, `createdAt`, `updatedAt` | `label`, `provider_name`, `base_url`, `generation`, `input`, `reasoning`, `cost`, `enabled`, `is_default`, `needs_reconnection`, `aliased`, `source`, `created_by` |
| `POST /api/models/seed` body                                   | `credentialId` (5c)                                                                                                              | `model_ids`                                                                                                                                                        |
| `POST /api/models/seed` 201                                    | —                                                                                                                                | `created`, `ids`, `promoted_default`                                                                                                                               |
| `POST /api/models/test` body                                   | `credentialId`, `modelId` (5c)                                                                                                   | `api_key`, `existing_model_id`                                                                                                                                     |
| `POST /api/model-providers-oauth/pairing` body                 | `providerId`, `credentialId` (5c)                                                                                                | —                                                                                                                                                                  |
| Pairing mint response                                          | `id`, `expiresAt`                                                                                                                | `token`, `command`                                                                                                                                                 |
| `GET /api/model-providers-oauth/pairing/{id}`                  | `id`, `expiresAt`, `credentialId` (5c)                                                                                           | `status`, `consumed_at`                                                                                                                                            |
| `POST /api/model-providers-oauth/pair/redeem` body             | `providerId`, `expiresAt` (4b)                                                                                                   | `label`, `access_token`, `refresh_token`, `email`, `account_id`                                                                                                    |
| `POST /api/model-providers-oauth/pair/redeem` 200              | `providerId`, `credentialId` (5c)                                                                                                | `email`, `available_model_ids`                                                                                                                                     |
| `GET /internal/oauth-token/{credentialId}` (+ `/refresh`)      | `expiresAt` (4b)                                                                                                                 | `access_token`, `account_id` (omitted when the provider surfaced none)                                                                                             |

`GET /internal/oauth-token/*` is typed once, as `OAuthTokenResponse` in `packages/core/src/sidecar-types.ts`; the platform route serializes its stored camelCase record into it and the sidecar maps it into its own cache entry. The platform, `PI_IMAGE` and `SIDECAR_IMAGE` ship this contract together.

**Why**: the registry names come from the module contract (`ModelProviderDefinition`) and travel camel/camel end-to-end (registry definition → API response → frontend read). One object has one casing family: only these exact names keep the module spelling; the rest of the object is an ordinary wire DTO.

#### Carve-out 4f — Connect-helper internal types

`@appstrate/connect-helper` (sibling repository) keeps its own TS types camelCase: `ProviderLoopback.displayName`, `NormalisedOAuthCredentials.expiresAt`, `PairRedeemResult.providerId`. The pairing-token header it decodes (`PairingTokenHeader` in `packages/core/src/pairing-token.ts`: `platformUrl`, `providerId`) is a TS type encoded as one-letter keys. The body it POSTs to `/api/model-providers-oauth/pair/redeem` and the response it reads are wire, spelled as in the 4e table.

#### Carve-out 4g — JSONB contracts

**The boundary rule.** A JSONB column whose value a route returns or accepts **as-is** (no per-key projection) is a **wire payload**: its platform-written interior keys follow Zone 1 (snake_case, with the 4b names camelCase). A JSONB column that never crosses the wire verbatim is an internal contract and keeps its producer's casing. A column whose content the CLIENT or the AGENT supplies is opaque: the platform stores and returns it verbatim and never keys it.

**Wire-exposed, platform-written — snake_case interior**:

| JSONB column                                                                                                                                    | Interior                                                                                                                                                                                                       | Returned by                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `organizations.org_settings`                                                                                                                    | `api_version`, `dashboard_sso_enabled`, `restrict_package_copy`, …                                                                                                                                             | `GET`/`PATCH /api/orgs/{orgId}/settings`                               |
| `runs.metadata`                                                                                                                                 | `degraded_integrations`, …                                                                                                                                                                                     | the run DTO                                                            |
| `runs.generation_config`, `runs.generation_config_override`, `space_packages.generation_config`, `package_schedules.generation_config_override` | `ModelGenerationSettings` (`packages/core/src/model-generation.ts`): `temperature`, `reasoning_level`                                                                                                          | run DTO (`generation`, `generation_override`), space package, schedule |
| `runs.token_usage`                                                                                                                              | `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` (Anthropic/OpenAI SDK names)                                                                                         | run DTO `token_usage`                                                  |
| `notifications.payload`                                                                                                                         | `packageId` (4b), `status` (`run_completed`); `packageId`, `package_type`, `shared_by_name` (`package_shared`)                                                                                                 | `GET /api/notifications`                                               |
| `spaces.settings`                                                                                                                               | `allowedRedirectDomains` (4n); `branding.{name, logo_url, primary_color, accent_color, support_email, from_name}`                                                                                              | the spaces routes                                                      |
| `run_logs.data` (platform-written keys)                                                                                                         | `integration_id` (`integration_dropped`), `file_id`, `uri`, `name`, `mime`, `size` (published file), `exit_code` (`firecracker_console`)                                                                       | `GET /api/runs/{id}/logs`, `run_log` SSE                               |
| `integration_connections.identity_claims`                                                                                                       | the manifest's `identity_claims` keys — snake_case, refused otherwise on every package write (`findNonSnakeCaseIdentityClaimKeys`, see the manifest section); a stored manifest predating the rule still reads | connection DTOs                                                        |

**Opaque, producer-defined** (client- or agent-supplied, returned verbatim): `runs.input`, `runs.result`, `runs.checkpoint`, `package_schedules.input`, `runs.context_snapshot` (caller-supplied environment metadata), `end_users.metadata`, `package_persistence.content`. Manifests (`packages.draft_manifest`, `package_versions.manifest`) are AFPS, hence snake_case by Zone 1. `chat_messages.content` is an AI SDK `UIMessage` (third-party vocabulary), with Appstrate's own `metadata` under 4o.

**Internal-only** (never returned verbatim — producer casing): `audit_events.before` / `after` (camelCase, 4m), `runs.model_cost` (`ModelCost`), `runs.resolved_connections` (projected per key into the snake_case `connections_used`), `runs.resolved_integration_versions`.

When adding a JSONB column, decide up front which of the three it is. If a route starts returning an internal blob verbatim, its keys become wire and must be snake_case; renaming a key of a wire-exposed column is a breaking wire change and needs a `scripts/migration/` rewrite of the stored rows.

#### Carve-out 4h — SSE event payloads

**Files**: `apps/api/src/services/realtime.ts` (`snakeToCamel`), `packages/shared-types/src/realtime-events.ts` (the Zod schema of every frame, validated on emit and on receipt).

**Rule**: SSE frames are camelCase at the top level. PG NOTIFY payloads are snake_case (they match the SQL columns); `realtime.ts` camelizes them **shallowly** before broadcast, so nested objects keep their own casing (`tokenUsage: { input_tokens, … }`, and a `run_log` frame's `data` is the `run_logs.data` JSONB with its Zone 1 keys).

**Channels**:

- `run_update` — `operation`, `id`, `packageId`, `status`, `userId`, `endUserId`, `orgId`, `spaceId`, `scheduleId`, `error`, `startedAt`, `completedAt`, `duration`.
- `run_log` — `id`, `runId`, `orgId`, `spaceId`, `type`, `level`, `event`, `message`, `data`, `createdAt`.
- `run_metric` — `runId`, `orgId`, `spaceId`, `packageId`, `tokenUsage`, `costSoFar`, `costPricingStatus`.
- `connection_update` — `operation`, `id`, `integrationPackageId`, `authKey`, `userId`, `endUserId`, `spaceId`, `needsReconnection`, `deleted`. Actor-scoped server-side via subscriber filter on `userId`/`endUserId`.
- `chat_session_update` — `sessionId`, `orgId`, `userId` (application-emitted by the chat module).

**Why**: an SSE frame is a TS-typed stream contract shared by the server and the SPA through one Zod schema, not a REST body. The run DTO and the `run_update` frame therefore spell the same fields differently (5b); `runUpdateToRunPatch` in `realtime-events.ts` is the one place that maps between them.

#### Carve-out 4i — Run events (CloudEvents-style)

**Files**: `packages/afps-runtime/src/types/canonical-events.ts`, `packages/afps-runtime/src/types/run-result.ts`

**Rule**: event envelopes and payloads are camelCase — `BaseEnvelope`: `runId`, `toolCallId`, `timestamp`; payloads: `durationMs`, … The `file.published` event (emitted by `runtime-pi/publish.ts`, consumed by `apps/api/src/services/run-launcher/appstrate-event-sink.ts`) carries `fileId`; the run-log row the platform writes from it is Zone 1 (`file_id`, 4g).

The runner→platform ingestion routes (`/api/runs/{runId}/events*`) carry this vocabulary, which is why the finalize body (`POST /api/runs/{runId}/events/finalize`, `TerminalRunResult`) declares `durationMs` in the OpenAPI spec.

**Why**: CloudEvents spec uses camelCase for context attributes; consistent producer/consumer across the runtime, the sidecar and the platform.

#### Carve-out 4j — Webhook delivery payloads (Standard Webhooks spec)

**File**: `apps/api/src/modules/webhooks/service.ts`

**Rule**: Envelope (`id`, `object`, `type`, `apiVersion`, `timestamp`, `data`) + inner payload all camelCase. `timestamp` is the Standard Webhooks payload field, an RFC 3339 string. Includes `packageId`, `resultTruncated`, `inputTruncated`, `actor: { type, id }`, `errors: [{ field, code, message, title }]`.

#### Carve-out 4k — BullMQ job data

**Rule**: All camelCase. Opaque to consumers outside the queue layer.

| Type                                                      | File                                                              |
| --------------------------------------------------------- | ----------------------------------------------------------------- |
| `ScheduleJobData`                                         | `apps/api/src/services/scheduler.ts`                              |
| `DeliveryJobData`                                         | `apps/api/src/modules/webhooks/service.ts`                        |
| `CompactionJobData` (`retentionDays`)                     | `apps/api/src/services/inline-compaction.ts`                      |
| `LlmUsageRetryJob` (`entry: LlmUsageEntry`, `onConflict`) | `apps/api/src/services/llm-usage-retry.ts`, `llm-usage-ledger.ts` |
| `RefreshJobData` (`credentialId`, `providerId`)           | `apps/api/src/services/model-providers/refresh-worker.ts`         |

The model-provider refresh scan, the pairing cleanup and the personal-space sweeper queues carry an empty payload.

#### Carve-out 4l — Logger fields (pino convention)

**Rule**: `logger.info({ runId, orgId, error })` — camelCase.

**Why**: pino style, indexable in Datadog/ELK/CloudWatch queries.

#### Carve-out 4m — Audit log JSONB payloads

**Rule**: `recordAuditFromContext({ after: { keyA, keyB } })` — camelCase explicit keys (NOT the raw snake_case request body).

**Enforced by type**: `AuditPayload` (`packages/core/src/module.ts`) types `before` / `after` on the platform writer (`apps/api/src/services/audit.ts`) and on `PlatformServices.audit.record`. A top-level key containing `_` does not compile, and neither does a `Record<string, unknown>` that could hide one. Only top-level keys are checked: a value that is itself a wire JSONB field keeps its own interior casing.

**Pattern**: when audit-logging an update, the route handler maps the snake_case request body to camelCase explicit keys:

```typescript
await recordAuditFromContext({
  action: "schedule.updated",
  after: {
    cronExpression: data.cron_expression,
    modelIdOverride: data.model_id_override,
    // ... explicit camelCase keys, not the raw body
  },
});
```

Reason: SIEM queries (Datadog, Splunk) need stable field names.

#### Carve-out 4n — Headless-platform DTO fields (camelCase end-to-end)

**Files**:

- `packages/shared-types/src/index.ts` (`ApiKeyInfo`, `SpaceInfo`, `EndUserInfo`, `OrgProxyInfo`)
- `apps/api/src/lib/list-response.ts` (`listResponse`, the list envelope)
- `apps/api/src/openapi/schemas.ts` + `paths/{api-keys,spaces,end-users,proxies}.ts`
- Webhook module CRUD surface (`apps/api/src/modules/webhooks/`, its `openapi/`)

**Rule**: a fixed set of headless-platform / developer-surface wire fields stays **camelCase** end-to-end (TS schema + service + OpenAPI + frontend hook all match):

- API key surface: `keyPrefix`
- Proxy surface: `urlPrefix`
- Space / end-user surface: `externalId`, `isDefault`, `allowedRedirectDomains`
- List envelope: `hasMore` — every list goes through `listResponse` (`{ object: "list", data, hasMore }`), `GET /api/notifications` and `GET /api/files` included; cursor params `startingAfter` / `endingBefore`
- Webhook CRUD surface: `payloadMode`, `eventId`, `eventType`, `statusCode`; secret rotation (`POST /api/webhooks/{id}/rotate`): `windowSeconds`, `secretPrevious`, `rotationWindowEndsAt`

**Why**: developer-platform surfaces modelled on the Stripe headless API convention (camelCase for developer-platform CRUD). End-to-end coherent; flipping is a breaking change for external API consumers with zero user-visible benefit. For any new endpoint family, snake_case wire per the Zone 1 default.

#### Carve-out 4o — Chat message metadata (`appstrate.turn`)

**File**: `packages/core/src/chat-turn-metadata.ts` (`AppstrateTurnMetadata`). Its fields (`finishReason`, `errorCategory`, `stepCount`, `modelId`, `modelLabel`, …) are **camelCase**: they ride the AI SDK's `messageMetadata` on the UI message stream and are persisted inside the stored message (`chat_messages.content`, an AI SDK `UIMessage`), a TS contract shared by the engine and the chat UI rather than a REST body.

#### Carve-out 4p — Agent tool arguments (`api_call` / `api_upload`)

**Files**: `runtime-pi/sidecar/mcp.ts` (the `{ns}__api_call` / `{ns}__api_upload` input schemas), `packages/afps-runtime/src/resolvers/{integration-api-call,http-call-core}.ts` (agent-side resolution).

**Rule**: the argument vocabulary of these two tools is camelCase: `fromFile`, `fromBytes`, `contentType` (multipart parts), `substituteBody`, `responseMode.{toFile, maxInlineBytes}`, `uploadProtocol`, `sourceMimeType`, `partSizeBytes`.

**Why**: an LLM-facing tool schema, not a REST body — agent prompts and skills are written against these names, so renaming one silently breaks every agent that uses it. The platform's own MCP server (`apps/api/src/modules/mcp/tools.ts`) is a different surface and follows Zone 1: `list_files` takes `runId` (4b), `chat_session_id`, `purpose` and refuses any other argument; `invoke_operation` takes `if_match`.

#### Carve-out 4q — AFPS bundle container

**Files**: `packages/afps-runtime/src/bundle/{types,build,read,signing}.ts`

**Rule**: the `.afps-bundle` container's own files are camelCase: `bundle.json` `bundleFormatVersion`, bundle metadata `createdAt`, `builder`, `sourceRunId`; `signature.sig` `alg`, `keyId`, `signature`, `chain[].{keyId, publicKey, signature, parentKeyId}`. The packages inside a bundle are AFPS manifests, snake_case by Zone 1.

**Why**: a versioned file format, gated by the `bundleFormatVersion` major in `readBundleFromBuffer` and read by the standalone `afps` CLI (`sign`, `verify`, `inspect`). Bundles and signatures already issued must keep verifying; the key names are part of the format.

#### Carve-out 4r — `ExecutionContext`

**File**: `packages/afps-runtime/src/types/execution-context.ts` (`executionContextSchema`)

**Rule**: camelCase — `runId`, `input`, `memories[].{content, createdAt}`, `checkpoint`, `pinnedSlots`, `history[].{runId, timestamp, output}`, `traceparent`, `timeoutSeconds`.

**Why**: the runtime state handed to an AFPS runner at boot (and exported as `context.json` for replay) — a TS contract of the runtime package, not an HTTP body.

#### Carve-out 4s — Firecracker runner-daemon protocol

**File**: `apps/api/src/modules/firecracker/runner/protocol.ts` (Zod schemas shared by `remote-orchestrator.ts` and the daemon in `runner/`)

**Rule**: camelCase (`runId`, `memoryBytes`, `nanoCpus`, `maxLifetimeSeconds`, `sidecarUrl`, `llmProxyUrl`, `forwardProxyUrl`, …).

**Why**: an internal RPC between the platform and an `appstrate-runner` host daemon of the same release, never exposed as public API and absent from the OpenAPI spec.

#### Carve-out 4t — Sidecar and agent-container boot contracts

**Files**: `packages/core/src/sidecar-types.ts` (`SidecarConfig`, `SidecarLaunchSpec`, `LlmProxyConfig`, `ModelSwap`, `ModelSwapBacking`), `apps/api/src/services/orchestrator/sidecar-env.ts`, `packages/runner-pi/src/container-env.ts`

**Rule**: the configuration the platform serializes into a sidecar's or agent container's environment is camelCase (`PI_LLM_OAUTH_CONFIG_JSON`, `PI_MODEL_SWAP_JSON`: `authMode`, `clientApiShape`, `backing.{providerId, reasoningLevelMap, …}`, `anthropicAdaptiveReasoning`; `MODEL_COST`: `ModelCost`).

**Why**: written and read by the platform/`PI_IMAGE`/`SIDECAR_IMAGE` trio of one release, never by a third party. The HTTP endpoints the sidecar calls back (`/internal/*`) are wire and follow Zone 1: `/internal/integration-credentials/*` and `/internal/oauth-token/*` (4e table).

---

### Zone 5 — Documented asymmetries (low-impact)

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

Credentials/clients/proxies envelopes follow the TS object convention (they map to TS types: `providerId`, `apiKey`, `baseUrlOverride`, `modelId`, …). Limit-config envelopes follow the JSON wire convention.

#### 5b — SSE vs REST wire on the same logical entity

SSE Run payload is camelCase (per Carve-out 4h). REST Run payload mixes snake_case (domain) + camelCase (universal DB convention). The same logical Run has two field-name shapes depending on transport; `runUpdateToRunPatch` maps one onto the other.

#### 5c — Model/proxy/credential ids

**Rule — name-based, like 4b**: `modelId`, `proxyId` and `credentialId` are camelCase **wherever they hold the org model, proxy or model-provider credential id**:

- `GET`/`PATCH /api/agents/{scope}/{name}/model` (`modelId`) and `GET`/`PUT /api/agents/{scope}/{name}/proxy` (`proxyId`)
- the org model surface `/api/models*` (`modelId`, `credentialId`; `PUT /api/models/default` takes `modelId`)
- `PUT /api/proxies/default` (`proxyId`)
- the space package (`space_package` on `/api/spaces/{spaceId}/packages*`, and its `PATCH` body): `modelId`, `proxyId` — beside the snake_case `generation_config`
- `ResolvedRunConfig` (`GET /api/spaces/{spaceId}/packages/{scope}/{name}/run-config`): `modelId`, `proxyId`, beside `generation` and `input`
- the run-launch bodies (`POST /api/agents/{scope}/{name}/run`, `POST /api/runs/inline` and `/inline/validate`): `modelId`, `proxyId`; the chat body (`POST /api/chat`): `modelId`
- the model-provider family (4e table): `credentialId` on the discover and pairing bodies, the pairing status and the redeem response

**Other names are Zone 1**: a schedule's overrides are `model_id_override`, `proxy_id_override`, `version_override`; `/api/models/test` takes `existing_model_id` next to its 5c ids. The MCP `run_and_wait` tool takes no model or proxy.

**Why**: one fact, one spelling. The same id travels from the space package to `run-config` to a launch body; two spellings of it are the drift this document exists to prevent. They are not 4b names because they are not DB-convention columns shared across tables. A new field holding one of these ids uses the same name.

#### 5d — Better Auth plugin management surfaces (plugin pass-through)

Management routes over Better Auth plugin tables mirror the table's TS field names (Carve-out 4a chain):

- **OAuth clients** — `/api/oauth/clients`, `/api/oauth/clients/{clientId}`, `…/rotate` (CRUD on the `oauthClient` table): `clientId`, `clientSecret`, `redirectUris`, `postLogoutRedirectUris`, `isFirstParty`, `allowSignup`, `signupRole`, `signupSpaceAssignments`, `referencedOrgId`, `referencedSpaceId`.
- **CLI sessions** — `/api/auth/cli/*` (`token`, `revoke`, `sessions`, `sessions/revoke`, `sessions/revoke-all`) and `/api/orgs/{orgId}/cli-sessions[/{familyId}]` (the `cliRefreshToken` table): `familyId`, `deviceName`, `userAgent`, `createdIp`, `lastUsedIp`, `userName`, `userEmail`, `revokedCount`.

The actual OAuth 2.0 wire endpoints (`/oauth2/authorize`, `/oauth2/token`, the CLI token grant's `client_id`) stay snake_case per RFC 6749 — only the management surface is camelCase. Unlike the other named carve-outs, these names are **surface-scoped**: the OpenAPI gate accepts them only under the paths and components of the two surfaces above, so `clientId` on any other object (the per-space social provider's `client_id`, say) still fails. Treat any new management route over a BA plugin table the same way; for non-plugin tables the default snake_case wire rule applies.

---

## Query-string parameters

Query params are wire surface. They follow the **same rule as wire JSON (Zone 1): snake_case by default**, with the same carve-outs applied by literal name:

- **Universal DB-convention names** (Carve-out 4b): `?runId=` (`GET /api/files`, `GET /api/agents/{scope}/{name}/persistence`), `?packageId=` (`GET /api/files`), `?spaceId=` (`GET /api/webhooks`).
- **Pagination-envelope params** (Carve-out 4n): the cursor params `startingAfter` / `endingBefore` pair with the camelCase `hasMore` body field.
- **Headless-platform surface params** mirror their Carve-out 4n wire fields: `?externalId=` on `GET /api/end-users`.

Conforming snake_case examples: `?actor_type=&actor_id=` on the persistence route (`routes/agents.ts`); `?chat_session_id=` on `GET /api/files`; OAuth 2.0 wire params `?client_id=`, `?post_logout_redirect_uri=` (RFC 6749, Zone 1). Single bare tokens (`limit`, `kind`, `status`, `q`, `since`, `purpose`) are trivially conforming.

**Path parameter names are not wire.** `{authKey}`, `{connectionId}`, `{agentPackageId}`, `{invitationId}`, `{credentialId}` name a template slot; only their values travel in the URL. They are route-authoring identifiers and are neither checked by the OpenAPI gate nor governed by this rule.

A new camelCase domain query param is a bug, same as a camelCase domain wire field.

### Pagination styles (which one to use)

Three pagination idioms exist; choose by collection shape, never mix styles on one endpoint. All three emit RFC 5988 `Link` headers via `apps/api/src/lib/pagination-link.ts`:

| Style                 | Params                                            | Use for                                                           | Example                                                                                               |
| --------------------- | ------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Cursor (Stripe-style) | `startingAfter` / `endingBefore` + `hasMore` body | Unbounded user-facing collections                                 | `GET /api/end-users`, `GET /api/notifications`, `GET /api/files`, `GET /api/webhooks/{id}/deliveries` |
| Offset                | `limit` + `offset`                                | Bounded admin lists                                               | `GET /api/runs` (`routes/runs.ts`); also schedules and the integration list                           |
| Sequence cursor       | `since` (monotonic id)                            | Append-only log streams ONLY — doubles as the polling-tail cursor | `GET /api/runs/{id}/logs` (`routes/runs.ts`)                                                          |

---

## Package identifiers in URL paths

A package (`@scope/name`) appears in API paths in **two shapes**, by an explicit rule:

- **Single top-level package → `{scope}/{name}`** (two path params). Route pattern `/:scope{@[^/]+}/:name`. Used by agents, `packages/*` (registry tier), runs, schedules.
- **Route references ≥2 packages → `{packageId}`** (one param holding `@scope/name`). Route pattern `/:packageId{@[^/]+/[^/]+}`. Used by `/api/integrations/*` (runtime tier), where routes like `/integrations/{packageId}/agent-resolution/{agentPackageId}` carry two packages in one path — two `{scope}/{name}` pairs would be ambiguous to parse.

Both shapes resolve to the **same on-wire path** (`@foo/bar`); the difference is only how Hono splits it into params. So the choice is a route-authoring rule, not a wire-format difference.

**Encoding (the footgun):** naive `encodeURIComponent(packageId)` 404s **both** route shapes — it percent-encodes `@`→`%40` and `/`→`%2F`, which the route regexes reject. Consumers MUST use **`encodePackageIdPath(packageId)` from `@appstrate/core/naming`** — it validates the id and encodes each segment while keeping the `@`/`/` separators literal. Do not hand-roll a path encoder; do not call `encodeURIComponent` on the whole id.

```ts
import { encodePackageIdPath } from "@appstrate/core/naming";
api(`/integrations/${encodePackageIdPath(packageId)}/connections`);
```

This is the single canonical contract for frontend, SDK, github-action, and MCP consumers.

**Scope sigil in responses:** any `scope`-bearing response field (`AgentListItem.scope`, `AgentDetail.scope`, runs `agent_scope`) emits the scope **with** the leading `@` (e.g. `"@myorg"`) — the same format the `{scope}` path params accept, so one operation's output is directly usable as the next operation's input.

---

## Field-name catalog (canonical)

### Manifest fields (AFPS — all snake_case)

Authority: `afps-spec/packages/schema/src/schemas.ts`; Appstrate extensions are validated by `packages/core/src/{validation,integration,mcp-server}.ts`.

**Common** (every package type): `name`, `version`, `type`, `display_name`, `description`, `long_description`, `keywords`, `license`, `author`, `repository`, `homepage`, `documentation`, `support`, `icon`, `icons[].{src, theme, …}`, `screenshots`, `privacy_policies`, `compatibility.{platforms, runtimes, clients}`, `schema_version`, `dependencies`, `_meta`

**Dependencies subkeys**: `skills`, `mcp_servers`, `integrations`

**Agent extras**: `integrations_configuration.{id}.{tools, scopes, auth_key}`, `input`, `output`, `timeout`, `runtime_tools` (Appstrate extension)

**Agent resource extension**: `_meta["dev.appstrate/resources"].{memory_mb, cpu}`

**Wrapper (input/output)**: `schema`, `file_constraints`, `ui_hints`, `property_order`

- `file_constraints.{key}`: `accept`, `max_size`
- `ui_hints.{key}`: `placeholder`

**MCP-server (MCPB)**: `manifest_version`, `server.{type, entry_point, mcp_config}`, `mcp_config.{command, args, env, platform_overrides}`, `tools[].{name, description}`, `user_config`, `_meta["dev.appstrate/mcp-server"].runtime` (Appstrate Bun override; per AFPS the mcp-server manifest is AFPS-native at the root — no `_meta["dev.afps/mcp-server"]` identity wrapper)

**Integration**:

- `source.kind`: `"local" | "remote" | "none"`
- `source.server.{name, version, vendored}`
- `source.remote.{url, transport}`
- `_meta["dev.appstrate/api"].auths.<key>.upload_protocols`
- `auths.{key}.{type, issuer, authorization_endpoint, token_endpoint, userinfo_endpoint, token_endpoint_auth_method, code_challenge_methods_supported, resource, authorization_params, default_scopes, scope_catalog, identity_claims, required_identity_claims, credentials, connect, delivery, authorized_uris, allow_all_uris, callback_url_hint}`
- `auths.{key}.scope_catalog[].{value, label, description, implies}`
- `auths.{key}.identity_claims.{claim}` — claim keys are snake_case (`account_id`, `avatar_url`, `team_name`, …), and so are `connect.login.identity_outputs` entries. Every package write (create, save, publish, import) refuses any other key through `CONFIG_BY_TYPE.integration.checkManifest` (`findNonSnakeCaseIdentityClaimKeys`, `packages/core/src/integration.ts`), and the `identity-claim-keys` conformance check applies it to system packages. `integrationManifestSchema` does not: a published version is immutable, so a stored manifest declaring `accountId` still reads (its connections key on the `email` / `sub` fallback)
- `auths.{key}.connect.{login, tool, limits}`
- `auths.{key}.connect.login.{request, success_criteria, outputs, expires_in_output, identity_outputs}`
- `auths.{key}.connect.limits.{request_timeout_ms, max_response_bytes}`
- `auths.{key}.delivery.http.{in, name, prefix, value, encoding, allow_server_override}`
- `auths.{key}.delivery.env.{key}.{value, sensitive, user_config_key}`
- `auths.{key}.delivery.files.{key}.{value, mode}`
- `tools_policy.{name}.required_scopes` — a map keyed by auth key (`{ "<auth_key>": ["scope", …] }`)
- `hidden_tools`
- `allow_undeclared_tools`
- `default_tools` (Appstrate extension, validated by `packages/core/src/integration.ts`)
- `setup_guide.steps[].{label, url}`

### Wire DTO fields (apps/api responses and bodies)

**Mirror manifest** (snake_case on wire, projection from snake_case manifest):
`display_name`, `schema_version`

**Domain fields** (snake_case): `running_runs`, `used_by_agents`, `reused_by_agents`, `has_unarchived_changes`, `version_count`, `created_by`, `created_by_name`, `last_run`, `user_name`, `end_user_name`, `api_key_name`, `schedule_name`, `actor_name`, `actor_type`, `actor_id`, `manifest_name`, `latest_published_version`, `active_version`, `restored_version`, `total_connections`, `auto_installed`, `agent_scope`, `agent_name`, `package_ephemeral`, `inline_manifest`, `inline_prompt`, `runner_name`, `runner_kind`, `model_label`, `proxy_label`, `version_label`, `model_source`, `version_ref`, `token_usage`, `cost_pricing_status`, `cron_expression`, `connection_overrides`, `dependency_overrides`, `last_run_at`, `next_run_at`, `model_id_override`, `proxy_id_override`, `version_override`, `artifact_size`, `yanked_reason`, `dist_tags`, `draft_manifest`, `callback_url`, `started_at`, `completed_at`, `forked_from`, `read_at`

**Generation settings** (snake_case — `ModelGenerationSettings`, `ModelGenerationCapabilities` in `packages/core/src/model-generation.ts`): run DTO `generation`, `generation_override`; space package `generation_config`; schedule `generation_config_override`; agent model and launch bodies `generation`. Interior: `temperature`, `reasoning_level`. Capabilities on `OrgModel` and registry models: `generation.{temperature, reasoning.{supported, temperature_compatible, adaptive, levels, native_levels}}`.

**Run-launch and chat bodies** (snake_case beside the 5c ids): `input`, `rerun_from`, `modelId`, `proxyId`, `generation`, `connection_overrides`, `dependency_overrides` (agent run); an inline run adds `manifest`, `prompt`, `context_files` and drops `rerun_from` / `dependency_overrides`; chat: `id`, `messages`, `modelId`, `generation`, `agent_authoring` (strict). The remote-run body keeps the 4b `contextSnapshot` beside `sink.ttl_seconds`.

**Space-package DTO domain fields** (snake_case — `space_package` object on `/api/spaces/{id}/packages*`): `installed_at`, `package_type`, `package_source`, `draft_manifest`, `generation_config`. `modelId`/`proxyId` on the same object stay camelCase per asymmetry 5c. `installed_at` keeps the spelling of the column it aliases: the act is spelled activate / deactivate everywhere else, and renaming a column is a migration of rows rather than of code.

**Library DTO domain fields** (snake_case — `LibraryPackageList` and its `PackagePlacement` entries on `GET /api/library` and `GET /api/spaces/{id}/library`): `home_space_id`, `home_writable`, `home_shareable`, and on each placement `space_id`, `via`, `state`, `shared_by.{user_id, name}` (see the counter-exception below).

**Import-bundle response domain fields** (snake_case — `POST /api/packages/import-bundle` 201): `root_active`, `root_package_id`, `root_version`, and per-item `imported[].version_id`.

**Integration DTO domain fields** (snake_case): `scopes_granted`, `needs_reconnection`, `owner_type`, `owner_name`, `auth_key`, `account_id`, `shared_with_org`, `identity_claims`, `block_user_connections`, `has_oauth_client`, `has_client_secret`, `redirect_uri`, `missing_scopes`, `resolved_missing_scopes`, `resolved_owned_by_actor`, `org_default_enforced`, `can_add_connection`, `tool_catalog`, `required_scopes`, `source_id`, `source_type`, `client_id`, `client_secret`, `client_secret_hash`, `client_type`, `allowed_scopes`, `connected_at`, `force_account_select`, `connection_id`, `integration_id`, `integration_package_id`, `agent_package_id`, `admin_pinned_connection_id`, `member_pinned_connection_id`, `org_default_connection_id`, `resolved_connection_id`, `owner_id`, `owner_user_id`, `owner_end_user_id`, `is_own`, `connections_used[].{integration_id, label, account_id, source}`

**Model-provider family** (4e): the per-object table under Carve-out 4e — `api_key`, `base_url`, `base_url_override`, `existing_key_id`, `provider_name`, `available_model_ids`, `candidate_count`, `model_ids`, `promoted_default`, `existing_model_id`, `oauth_email`, `consumed_at`, `access_token`, `refresh_token`, `account_id`.

**OIDC management** (snake_case): SMTP `from_address`, `from_name`, `secure_mode`, test-send `message_id`; social provider `client_id`, `client_secret`; bootstrap redeem `bootstrap.org_slug`.

**Notifications and files**: notification `{ id, type, runId, payload, read_at, createdAt }` (payload per 4g); File DTO carries `runId`, `packageId`, `createdAt` (4b) beside its snake_case domain fields (`chat_session_id`, …); both lists use the 4n envelope.

**Error bodies**: `request_id`, `retry_after`, `errors[].{field, code, message, title}` (see [Error bodies](#error-bodies-rfc-9457)).

**Run log data** (platform-written, 4g): `integration_id`, `file_id`, `exit_code`.

**Internal sidecar↔platform wire fields** (snake_case, AFPS): the `/internal/integration-credentials/{scope}/{name}` GET + refresh endpoints emit all keys snake_case — `auth_key`, `auth_type`, `authorized_uris`, `scopes_granted`, `identity_claims`, `expires_at`, `delivery_plans`, `expires_at_epoch_ms`, and per-plan `header_name`, `header_prefix`, `allow_server_override`. The TS-internal source-of-truth type `IntegrationCredentialsWire` (in `@appstrate/connect/integration-credentials`) stays camelCase per the Zone 3 convention; field-name translation happens at the JSON boundary via `serializeIntegrationCredentialsWire` (platform-side) and `normalizeIntegrationCredentialsWire` (sidecar-side). There is no carve-out for these endpoints. The RFC 8707 audience is emitted as `resource`. `/internal/oauth-token/*`: see the 4e table.

**Billing wire** (`@appstrate/module-ee`): `usage_percent`, `credits_used`, `credit_quota`, `period_end`, `cancel_at_period_end`, `plan_id`, `return_url`

#### Universal DB convention (carve-out 4b) on the wire

camelCase: `id`, `createdAt`, `updatedAt`, `expiresAt`, `revokedAt`, `lastUsedAt`, `runNumber`, `userId`, `orgId`, `spaceId`, `packageId`, `runId`, `endUserId`, `apiKeyId`, `scheduleId`, `runOrigin`, `contextSnapshot`, `modelCredentialId`

**⚠️ The carve-out is this EXACT list — not a pattern.** Look-alikes that are NOT on the list are domain fields and go **snake_case on the wire**, even though they resemble a carve-out:

- `createdBy` → **`created_by`** (it is `*By`, an actor reference, not a timestamp/id).
- `createdByName` → **`created_by_name`**.
- `integrationId` → **`integration_id`**; `homeSpaceId` → **`home_space_id`**.

The snake_case twin of a 4b name is itself a bug, with an enumerated set of exceptions — the OpenAPI gate's `SNAKE_TWIN_EXCEPTIONS`, and nothing generalises from it:

- the package **placement / share** family: `space_id` on `PackagePlacement`, and `user_id` inside `shared_by` on both `PackagePlacement` and `PackageShare`. They sit beside `home_space_id` in the same objects, and two ids of one kind disagreeing inside one object would cost more than either convention buys. Elsewhere in the same family `spaceId` and `userId` stay camelCase: a share's `target` (`ShareTarget` / `ShareTargetView`: `userId`, `spaceId`), `PackageShare.createdAt`, `SpaceAssignment.spaceId` (invitations, OAuth signup policies) and `SpaceSweepResult.spaceId`;
- `expires_at` on the OAuth 2.0 token response (`POST /api/auth/oauth2/token`, RFC 6749 wire) and on the internal `IntegrationCredentialsResponse` (snake_case end to end, above).

Rule of thumb: a field qualifies for the camelCase carve-out only if its literal name appears in the list above — never by suffix similarity.

---

## How to make a decision when adding a new field

1. **Is it a manifest field?** → snake_case (always, no exception).
2. **Is it a SQL identifier?** → snake_case (Drizzle SQL alias, explicit constraint names).
3. **Is it a Drizzle TS field?** → camelCase (matches SQL via `text("snake_alias")`).
4. **Is it a wire DTO field, request-body field or error extension member?**
   - Is its literal name on a carve-out list (4b, 4c, 4e, 4n, 5c, 5d)? → camelCase, on the surface that list names
   - Otherwise → snake_case
5. **Is it a query-string parameter?** → same rule as the wire DTO. Path-template parameter names are not wire.
6. **Is it an OpenAPI component property or example key?** → match the wire DTO.
7. **Is it on a Better Auth-managed table?** → camelCase (TS), snake_case (SQL alias).
8. **Is it a model-provider field?** → camelCase only if it is a 4e name; the rest of the object is snake_case.
9. **Is it on a module hook params interface?** → camelCase (TS function-arg convention).
10. **Is it an internal TS variable, function arg, React prop, hook param?** → camelCase.
11. **Is it a logger field, BullMQ job key, run event, webhook delivery payload, SSE frame key?** → camelCase.
12. **Is it an agent tool argument, AFPS bundle container key, `ExecutionContext` key, runner-daemon or sidecar/container boot-config key?** → camelCase (4p–4t).
13. **Is it a key inside a JSONB column?** → returned verbatim and platform-written: snake_case; client/agent-supplied: opaque; never returned verbatim: producer casing (4g).
14. **Is it an audit log `before`/`after` key?** → camelCase explicit keys (`AuditPayload` refuses anything else).
15. **Otherwise** → wire = snake_case, internal = camelCase. When ambiguous, **wire is the safer default for any external-facing surface**.

A new camelCase wire name answers step 4 with "no" unless this document gains a carve-out entry for it, in the same change that adds it to the gate's allowlist.

---

## SOTA evidence summary

| Surface                 | Our choice                               | SOTA reference                                                        |
| ----------------------- | ---------------------------------------- | --------------------------------------------------------------------- |
| Wire JSON               | snake_case                               | Stripe, GitHub, AWS, OpenAI, Anthropic, Twilio, Slack                 |
| OAuth 2.0 wire          | snake_case (`client_id`, `redirect_uri`) | RFC 6749 mandate                                                      |
| Error bodies            | RFC 9457 + snake_case extensions         | RFC 9457, Stripe error object                                         |
| SQL identifiers         | snake_case                               | PostgreSQL/MySQL/SQLite universal                                     |
| Drizzle TS layer        | camelCase TS / snake_case SQL            | Prisma, Drizzle, TypeORM, Kysely, MikroORM (~95% of TS ORM ecosystem) |
| TS internal             | camelCase                                | TC39, ESLint default, Prettier, TypeScript style guide                |
| Better Auth integration | camelCase TS / snake_case SQL alias      | Better Auth official docs Option 4                                    |
| JSONB token usage       | snake_case (`input_tokens`)              | Anthropic + OpenAI SDK convention                                     |
| CloudEvents             | camelCase                                | CloudEvents spec                                                      |
| Logger fields           | camelCase                                | pino convention                                                       |

The deliberate departure from strict snake_case wire is the set of named camelCase carve-outs (4b, 4c, 4e, 4n, 5c, 5d): each is either a Better Auth blocker (4a chain, 5d) or a fixed set of names whose rename would cost every API consumer a breaking change for no user-visible benefit.

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
**Why rejected**: the frames are a typed TS contract shared through one Zod schema, the mapping to the run DTO lives in one function, low impact.

### Rejected — Normalize env-vars JSON to single casing

**Why considered**: split between camelCase (credentials) and snake_case (limits).
**Why rejected**: Both shapes work, low impact, breaking change for operators with existing env files.

---

## Enforcement

| Gate                                                                                           | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/test/unit/openapi-casing-carve-out.test.ts`                                          | Walks the built OpenAPI spec (core + every module) and DISCOVERS names: every property name, query parameter name and example/default key holding an uppercase letter must be in its exported `CAMEL_CASE_CARVE_OUTS` (name → section of this document). An entry is name-based (valid anywhere) except the 5d names, which carry the JSON-pointer prefixes of their surface (the `OAuthClient*` components and `/api/oauth/clients*`; `/api/auth/cli/*` and `/api/orgs/{orgId}/cli-sessions*`) and fail elsewhere. Every entry must still be in use within its scope. It also fails on the snake_case twin of a 4b or pagination name outside `SNAKE_TWIN_EXCEPTIONS` (exact JSON pointers). Example subtrees that are opaque data are not walked: `input`, `checkpoint`, `headers` anywhere, `payload` only under `/api/webhooks*` (a notification `payload` is walked). |
| `packages/db/test/schema-casing.test.ts`, `packages/module-ee/test/unit/schema-casing.test.ts` | Zone 2 for both schemas: every Drizzle TS column key is camelCase, and every SQL table, column, index, foreign key, unique, primary key and check name is snake_case.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `AuditPayload` (`packages/core/src/module.ts`)                                                 | Carve-out 4m at compile time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `findNonSnakeCaseIdentityClaimKeys` (`packages/core/src/integration.ts`)                       | `identity_claims` keys and `connect.login.identity_outputs` entries are snake_case: refused on every package write (`CONFIG_BY_TYPE.integration.checkManifest`, `apps/api/src/services/package-items/config.ts`) and failed by the `identity-claim-keys` conformance check on system packages. Not a read-path rule: stored manifests stay readable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `bun run lint:manifest-casing` (`scripts/lint-manifest-casing.ts`, in `bun run check`)         | No legacy camelCase AFPS manifest key in a manifest-writing context.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**The allowlist and this document must agree.** Adding a camelCase wire name means adding it to `CAMEL_CASE_CARVE_OUTS` with the section that justifies it AND listing it in that section here; an entry with no section here is a bug in the change that added it.

What the gates cannot see — TS code reading a wire field under the wrong name (undefined at runtime), SSE frames, JSONB interiors, tool schemas — is the job of the full audit:

```bash
# In Claude Code:
/audit-casing
```

The `/audit-casing` skill dispatches parallel opus sub-agents to verify every dimension against this document and reports any deviation.

---

## Related files

- `AGENTS.md` (repo root) — references this doc
- `.claude/commands/audit-casing.md` — automated audit skill
- `apps/api/test/unit/openapi-casing-carve-out.test.ts` — wire casing gate
- `packages/db/test/schema-casing.test.ts`, `packages/module-ee/test/unit/schema-casing.test.ts` — Drizzle casing gates
- `packages/core/src/validation.ts`, `packages/core/src/integration.ts` — appstrate Zod validators
- `packages/core/src/api-errors.ts` — problem documents
- `packages/shared-types/src/index.ts`, `packages/shared-types/src/realtime-events.ts` — wire DTO and SSE types
- `apps/api/src/openapi/schemas.ts` — OpenAPI components
- `scripts/migration/README.md` — the data rewrites that move stored JSONB keys to the current spelling
- AFPS canonical spec (snake_case authority) — <https://github.com/appstrate/afps-spec/blob/main/spec.md>
