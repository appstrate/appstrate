// SPDX-License-Identifier: Apache-2.0

import {
  pgTable,
  text,
  timestamp,
  boolean,
  uuid,
  integer,
  bigint,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
  check,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { orgRoleEnum, invitationStatusEnum } from "./enums.ts";
import { user } from "./auth.ts";
import { spaces } from "./spaces.ts";

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").unique().notNull(),
    orgSettings: jsonb("org_settings").notNull().default({}),
    // The org's default model — a flat model id that may name a system model
    // (SYSTEM_PROVIDER_KEYS) OR an `org_models.id` (UUID). A pointer rather than
    // an `is_default` boolean on `org_models` so the default can point at a
    // system model too (mirrors the integration `client_ref` pattern): picking
    // any row — system or custom — makes exactly that row the default. NULL ⇒ no
    // explicit default; the resolution cascade falls to the system-flagged model.
    // No FK: a system id is not a DB row. Stale custom ids are cleared on delete
    // and ignored by the resolver (it falls through to the cascade).
    defaultModelId: text("default_model_id"),
    // The org's default proxy — same pointer pattern as `default_model_id`: a flat
    // proxy id naming a system proxy (SYSTEM_PROXIES) OR an `org_proxies.id` (UUID).
    // A pointer rather than an `is_default` boolean on `org_proxies` so the default
    // can point at a system proxy too; picking any row — system or custom — makes
    // exactly that one the default. NULL ⇒ no explicit default; the resolver falls
    // to the system-flagged proxy then `PROXY_URL`. No FK (a system id is not a DB
    // row); stale custom ids are cleared on delete and ignored by the resolver.
    defaultProxyId: text("default_proxy_id"),
    // Running total of durable file bytes stored by this org. Maintained
    // transactionally alongside `files` insert/delete so the synchronous
    // org-storage quota check (`ORG_STORAGE_QUOTA_BYTES`) needs no aggregate
    // scan. bigint (mode: number) — total storage far exceeds the int4 ceiling.
    // FK cascade deletes (run/chat-session/end-user/space removed) drop
    // `files` rows WITHOUT the space-level decrement, so the counter can drift
    // high; `reconcileOrgFileBytes()` (files.ts GC loop, ~daily) recomputes
    // it from `SUM(files.size)` and corrects the drift.
    filesBytesUsed: bigint("files_bytes_used", { mode: "number" }).notNull().default(0),
    // Per-org durable-file storage limit, in bytes. NULL = no per-org override
    // (the org falls back to the global env quota). Resolution order the write path
    // enforces (see `effectiveOrgStorageLimit` in files.ts):
    //   organizations.files_bytes_limit ?? env.ORG_STORAGE_QUOTA_BYTES ?? unlimited
    // Pilotable per-org by the out-of-repo cloud module via the narrow
    // `PlatformServices.setFileStorageLimit` capability. The core stays
    // billing-neutral: this is a technical byte ceiling, never a plan or price.
    // bigint (mode: number) — mirrors `files_bytes_used` above.
    filesBytesLimit: bigint("files_bytes_limit", { mode: "number" }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Referencing-side index for the `user` SET NULL action (0048).
    // Postgres indexes only the REFERENCED side of a foreign key; without
    // this, deleting one user seq-scans this table under the deletion's lock.
    index("idx_organizations_created_by").on(table.createdBy),
  ],
);

export const organizationMembers = pgTable(
  "org_members",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: orgRoleEnum("role").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.userId] }),
    index("idx_org_members_user_id").on(table.userId),
  ],
);

/**
 * Pending invitations to join an org.
 *
 * NOTE — there are deliberately no `accepted_by` / `accepted_at` columns, and
 * no `idx_org_invitations_accepted_by`. There were, written by
 * `markInvitationAccepted` (`services/invitations.ts`) beside the
 * `status = 'accepted'` flip, and read by nothing: `getOrgInvitations` — the
 * only list — filters `status = 'pending'`, so an accepted row never reaches
 * the route at all, and neither column appears in any DTO, OpenAPI schema or
 * SPA read. The two assertions in `invitations.test.ts` were the entire
 * readership, i.e. a test that only proved the write happened.
 *
 * The `status` enum already records THAT an invitation was accepted; who
 * accepted it and when is in the audit log, which outlives the row (the org
 * delete drops every invitation with it). Dropped by `0055`.
 *
 * That audit substitute is NOT something the drop inherited — it did not exist
 * when the columns went. `POST /invite/:token/accept` wrote no audit record at
 * all, so for the length of one review the attribution was simply gone, backed
 * by a claim nobody had implemented. The route now writes
 * `org.invitation_accepted` (`routes/invitations.ts`) AFTER the claim is won,
 * so the loser of a concurrent accept logs nothing, and
 * `invitations.test.ts` asserts the actor, the timestamp and the payload.
 * Delete that write and this paragraph becomes false again.
 *
 * If acceptance attribution is ever wanted on this TABLE, it needs a reader
 * designed with it — not these columns revived.
 */
export const orgInvitations = pgTable(
  "org_invitations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    token: text("token").notNull().unique(),
    email: text("email").notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    role: orgRoleEnum("role").notNull(),
    /**
     * Space memberships applied when the invitation is accepted (RBAC spec
     * §5). Wire-shaped (snake_case keys) because it is written straight from
     * the validated invite body and read straight back onto it:
     * `[{ space_id, preset_role } | { space_id, custom_role_id }]`.
     */
    spaceAssignments: jsonb("space_assignments")
      .$type<ReadonlyArray<{ space_id: string; preset_role?: string; custom_role_id?: string }>>()
      .notNull()
      .default([]),
    status: invitationStatusEnum("status").notNull().default("pending"),
    invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_org_invitations_org_id").on(table.orgId),
    index("idx_org_invitations_email").on(table.email),
    // Referencing-side index for the `user` SET NULL action (0048).
    // Postgres indexes only the REFERENCED side of a foreign key; without
    // this, deleting one user seq-scans this table under the deletion's lock.
    index("idx_org_invitations_invited_by").on(table.invitedBy),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_api_keys_org_id").on(table.orgId),
    index("idx_api_keys_space_id").on(table.spaceId),
    uniqueIndex("idx_api_keys_key_hash").on(table.keyHash),
    // Referencing-side index for the `user` SET NULL action (0048).
    // Postgres indexes only the REFERENCED side of a foreign key; without
    // this, deleting one user seq-scans this table under the deletion's lock.
    index("idx_api_keys_created_by").on(table.createdBy),
  ],
);

export const orgProxies = pgTable(
  "org_proxies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    urlEncrypted: text("url_encrypted").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    // The default proxy is an org-level pointer (`organizations.default_proxy_id`),
    // not a per-row boolean — so it can point at a system proxy too. See the
    // column comment on `organizations`.
    source: text("source").notNull().default("custom"), // "built-in" | "custom"
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_org_proxies_org_id").on(table.orgId),
    // Referencing-side index for the `user` SET NULL action (0048).
    // Postgres indexes only the REFERENCED side of a foreign key; without
    // this, deleting one user seq-scans this table under the deletion's lock.
    index("idx_org_proxies_created_by").on(table.createdBy),
    check("org_proxies_source_valid", sql`source IN ('built-in', 'custom')`),
  ],
);

/**
 * Unified credentials table for LLM model providers (API-key + OAuth alike).
 *
 * Sole credential store as of Phase 5 — the legacy `org_system_provider_keys`
 * table was dropped. `provider_id` is a free-text registry key (e.g. "openai",
 * "anthropic") — NOT a FK to `packages.id`. Inference wire format and default
 * base URL are read from the platform registry
 * (`apps/api/src/services/model-providers/registry.ts`) keyed by
 * `provider_id`. `base_url_override` is honored only for providers whose
 * registry entry has `baseUrlOverridable: true` (e.g. "openai-compatible").
 *
 * The encrypted blob's plaintext is a tagged union:
 *   { kind: "api_key", apiKey: string }
 *   { kind: "oauth",   accessToken, refreshToken, expiresAt, accountId?,
 *                       scopesGranted: string[], needsReconnection: boolean }
 *
 * Decryption goes through `services/model-provider-credentials.loadCredentials`,
 * which fans out to the right code path based on the registry's `authMode`.
 */
export const modelProviderCredentials = pgTable(
  "model_provider_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    providerId: text("provider_id").notNull(),
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    baseUrlOverride: text("base_url_override"),
    /**
     * Denormalized OAuth token expiry — duplicates `blob.expiresAt` from the
     * encrypted blob to enable an efficient SQL filter in the refresh worker
     * scan (avoids decrypting every row to test a single timestamp).
     *
     * The blob remains the source of truth; this column is a cache, written
     * by `updateOAuthCredentialTokens` / `createOAuthCredential`. NULL for
     * api-key credentials, OAuth blobs without an upstream-supplied expiry,
     * and (transiently) for rows that pre-date the column — those self-cure
     * on the next refresh. The worker's predicate (`expires_at IS NULL OR
     * expires_at < cutoff`) covers the backfill window without a one-shot
     * decrypt-and-rewrite migration.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // Consecutive token-refresh failures classified as *transient* (network /
    // 5xx / parse — NOT `invalid_grant`, which flips `blob.needsReconnection`
    // immediately). A transient failure on a still-valid token is a no-op for
    // the credential's usability (cached token keeps working), but a token that
    // is expired AND has failed refresh repeatedly is effectively dead while
    // looking healthy. This counter, gated on `expiresAt < now() - grace`,
    // escalates such a credential to `needsReconnection` so the dashboard and
    // the inference read path surface an actionable re-connect prompt instead
    // of every run dying opaquely. Reset to 0 on any successful token write
    // (`updateOAuthCredentialTokens`). Mirrors
    // `integration_connections.refresh_failure_count`.
    refreshFailureCount: integer("refresh_failure_count").notNull().default(0),
    // NOTE — there is deliberately no `last_refresh_failure_at` here. There was
    // one, written beside `refresh_failure_count` on every transient refresh
    // failure and read by nothing: no route, no DTO, no OpenAPI field, no
    // `cloud` consumer, no predicate. Its only readers were the integration
    // tests asserting the write happened. `refresh_failure_count` is the
    // column that drives the reconnect escalation; the timestamp was never
    // part of that predicate. Dropped by `0044_finish_file_rename`. If "when
    // did refresh last fail" is ever needed, build the reader first — a column
    // with no reader is not telemetry, it is write amplification.
    /**
     * Model ids empirically verified against this credential — filled by
     * the model-discovery probe (post-OAuth-import + manual refresh). The
     * server-side authorization record gating model seeding
     * (`routes/models.ts`). Per-credential because availability depends on
     * the account's plan (e.g. Claude Pro vs Max), not the provider.
     * NULL = never probed.
     *
     * PROBE PROVIDERS ONLY. Credentials of a `modelDiscovery: { mode:
     * "static" }` provider (subscription sign-ins: claude-code, codex) are
     * never probed, so their served set is a pure function of (provider
     * definition, pricing catalog) — identical for every credential of the
     * provider. It is derived on read by `resolveCredentialModelIds`
     * (apps/api, services/model-providers/credentials.ts) and this column is
     * neither written nor read for them; migration 0030 nulled the historical
     * rows. Read the column through that accessor, never directly.
     */
    availableModelIds: jsonb("available_model_ids").$type<string[]>(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_model_provider_credentials_org_provider").on(t.orgId, t.providerId),
    // Partial index — only OAuth rows have a non-null expiry. Keeps the
    // index small even on installations with millions of api-key rows.
    index("idx_model_provider_credentials_expires_at_oauth")
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} IS NOT NULL`),
    // Referencing-side index for the `user` SET NULL action (0048).
    // Postgres indexes only the REFERENCED side of a foreign key; without
    // this, deleting one user seq-scans this table under the deletion's lock.
    index("idx_model_provider_credentials_created_by").on(t.createdBy),
  ],
);

/**
 * One-shot pairing tokens that bridge the dashboard "Connect Claude Pro"
 * button with the `npx @appstrate/connect-helper <token>` loopback OAuth
 * helper running on the user's machine.
 *
 * Lifecycle:
 *   1. Dashboard POST /api/model-providers-oauth/pairing → row INSERTed,
 *      plaintext token returned to the browser ONCE (never re-served).
 *   2. Helper decodes the token client-side, runs the provider's loopback
 *      OAuth dance, then POSTs the resulting credentials to
 *      /api/model-providers-oauth/pair/redeem using the pairing token as
 *      Bearer credentials. The platform-side Bearer auth re-hashes the
 *      secret portion (SHA-256, base64url) and looks the row up by
 *      `token_hash`.
 *   3. The `consumePairing()` UPDATE atomically sets `consumed_at = now()`
 *      and returns the row only if it was previously unconsumed and
 *      unexpired — guaranteeing single-use semantics under concurrent
 *      retries.
 *   4. A background worker DELETEs rows past `expires_at + 1h` so the
 *      table never grows unboundedly. Consumed rows are kept for the
 *      grace window so audit/UI status reads can still reflect them.
 *
 * The plaintext token is `appp_<base64url(header)>.<base64url(secret)>`
 * — only the SHA-256 of the secret portion is persisted. The header
 * (platform URL + providerId) is carried inside the token itself so the
 * helper can decode it without an extra round-trip.
 */
export const modelProviderPairings = pgTable(
  "model_provider_pairings",
  {
    /** App-generated id with `pair_` prefix (matches existing `ask_`/`pair_` log conventions). */
    id: text("id").primaryKey(),
    /** SHA-256 of the secret portion, base64url-encoded. The plaintext is never stored. */
    tokenHash: text("token_hash").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Provider id from the OAuth model provider registry. */
    providerId: text("provider_id").notNull(),
    /**
     * Existing credential targeted by a reconnect pairing. NULL for a new
     * connection. Deliberately not a foreign key: if the credential is
     * deleted while the helper is running, redeem must retain the original
     * target id and fail instead of silently falling back to create mode.
     */
    reconnectCredentialId: uuid("reconnect_credential_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** When the helper successfully POSTed credentials. NULL means still pending. */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    // NOTE — there is deliberately no `consumed_from_ip` here. There was one,
    // written by `consumePairing` (`services/model-providers/pairings.ts`) and
    // read by nothing: no route, no DTO, no OpenAPI field, no `cloud` consumer.
    // Its "for audit" justification did not survive two facts:
    // `cleanupExpiredPairings` DELETEs the row an hour after expiry, and the
    // audit entry `handlePairRedeem` writes at redeem time omits the IP — so
    // the forensic trail it was meant to leave was erased, and the record that
    // survives never carried it. Dropped by `0044_finish_file_rename`. If the
    // consuming IP is wanted, put it in the audit `after` payload, which
    // outlives the row — do not re-add a column nothing reads.
    /**
     * Final `model_provider_credentials.id` created or reconnected by the
     * helper. NULL while pending; surfaced via `GET /pairing/:id` after redeem
     * so the UI can act on the result without polling the credential list.
     *
     * The FK is declared in the table-config block below with an EXPLICIT
     * name: drizzle's generated one,
     * `model_provider_pairings_credential_id_model_provider_credentials_id_fk`,
     * is 70 bytes and Postgres truncates silently at 63. See the block.
     */
    credentialId: uuid("credential_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_model_provider_pairings_org_id").on(table.orgId),
    // NOTE — there is deliberately no `expires_at` index.
    //
    // There was one, partial on `consumed_at IS NULL`, justified as "only
    // unconsumed rows matter for the cleanup scan". The cleanup scan
    // (`services/model-providers/pairings.cleanupExpiredPairings`) is
    // `DELETE ... WHERE expires_at < cutoff` with no `consumed_at` predicate —
    // it deletes consumed rows too, on purpose, since the grace window is what
    // bounds the table. The planner can therefore never prove the partial
    // index's predicate and never used it, so it was maintained on every
    // pending-pairing write and read by nothing. The only other `expires_at`
    // reader, `consumePairing`, is anchored on the unique `token_hash`.
    // If the cleanup scan ever becomes hot, add a NON-partial index on
    // `expires_at` — the partial shape cannot serve that query.
    //
    // EXPLICITLY NAMED (migration 0055). Drizzle's generated name,
    // `model_provider_pairings_credential_id_model_provider_credentials_id_fk`,
    // is 70 bytes; Postgres truncates identifiers past 63 at creation, without
    // a warning, so the catalog has only ever held
    // `model_provider_pairings_credential_id_model_provider_credential`. The
    // schema, the snapshot and `0000_init.sql` all carried the 70-byte form,
    // and the first statement to address it by name — the
    // `DROP CONSTRAINT "<declared name>"` drizzle-kit emits when an FK's
    // `onDelete` or target changes — would have errored 42704 and aborted the
    // whole pending batch. Same reasoning in full on
    // `integration_org_defaults.connectionId`, the other one of the two.
    foreignKey({
      columns: [table.credentialId],
      foreignColumns: [modelProviderCredentials.id],
      name: "model_provider_pairings_credential_id_fk",
    }).onDelete("set null"),
  ],
);

export const orgModels = pgTable(
  "org_models",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    modelId: text("model_id").notNull(),
    /**
     * Strict FK to `model_provider_credentials.id`. ON DELETE RESTRICT —
     * deleting a credential while any model still references it is rejected
     * at the DB level so the API can surface a clear error.
     *
     * The credential's `providerId` is the single source of truth for
     * `apiShape` and the default `baseUrl` — both are resolved from the
     * runtime registry (`getModelProvider`) at read time. `baseUrlOverride`
     * (on the credential row) is honored when `baseUrlOverridable: true`.
     */
    credentialId: uuid("credential_id")
      .notNull()
      .references(() => modelProviderCredentials.id, { onDelete: "restrict" }),
    input: jsonb("input"), // ["text", "image"] | null
    contextWindow: integer("context_window"), // 200000 | null
    maxTokens: integer("max_tokens"), // 16384 | null
    reasoning: boolean("reasoning"), // true | null
    cost: jsonb("cost"), // { input, output, cacheRead, cacheWrite } in $/M tokens | null
    enabled: boolean("enabled").notNull().default(true),
    // Model-alias flag (LLM-gateway alias pattern). When true, this row's `id`
    // is a public alias and its real binding (`modelId` + the credential's
    // provider/baseUrl) is stripped from user-facing surfaces; the sidecar
    // rewrites the `model` field in both directions. The real id stays
    // server-side (resolution + private `llm_usage` ledger).
    aliased: boolean("aliased").notNull().default(false),
    // The default model is an org-level pointer (`organizations.default_model_id`),
    // not a per-row boolean — so it can point at a system model too. See the
    // column comment on `organizations`.
    source: text("source").notNull().default("custom"), // "built-in" | "custom"
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_org_models_org_id").on(table.orgId),
    // Referencing-side index for the `user` SET NULL action (0048).
    // Postgres indexes only the REFERENCED side of a foreign key; without
    // this, deleting one user seq-scans this table under the deletion's lock.
    index("idx_org_models_created_by").on(table.createdBy),
    check("org_models_source_valid", sql`source IN ('built-in', 'custom')`),
  ],
);
