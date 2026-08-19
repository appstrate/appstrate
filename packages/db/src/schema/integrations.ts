// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS integration storage tables (Phase 1.1 — credential layer).
 *
 * The integration credential model is keyed per-auth:
 *
 *   - One integration manifest can declare 1..N auths
 *     (`auths.{key}` — proposal §4.1.1), each independently connected
 *     by the user. Status (`needsReconnection`, `expiresAt`,
 *     `scopesGranted`) is per-auth, not per-integration.
 *
 *   - Each (integration, auth) pair can hold multiple accounts (e.g.
 *     two Google accounts on the same Gmail integration). The
 *     `accountId` discriminator is extracted at connection time via
 *     the manifest's AFPS `auths.{key}.identity_claims` JSONPath
 *     map (§7.4) — the connect layer renders it into the row's
 *     `identityClaims` JSONB and `accountId` discriminator.
 *
 *   - Connections are scoped per application (every connect-able
 *     surface in Appstrate is application-scoped — see CLAUDE.md
 *     "Multi-tenant" section), with the owner being either a
 *     dashboard user (`userId`) or a headless end-user
 *     (`endUserId`), enforced by a check constraint.
 *
 * The runtime spawn flow (Phase 1.2a) hits this table once per declared
 * auth at integration boot, decrypts with the v1 credential envelope, and
 * feeds `resolveIntegrationCredentials`
 * (packages/connect/integration-credentials.ts).
 */

import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  uuid,
  index,
  uniqueIndex,
  jsonb,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth.ts";
import { applications, endUsers } from "./applications.ts";
import { packages } from "./packages.ts";

export const integrationConnections = pgTable(
  "integration_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** FK to the installed integration package (`packages.id`). */
    integrationId: text("integration_package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    /** Auth key as declared in `manifest.auths.{key}` (e.g. `"primary"`, `"github"`). */
    authKey: text("auth_key").notNull(),
    /** Discriminator for multi-account-per-auth (e.g. `sub` claim, email). */
    accountId: text("account_id").notNull(),
    /** Application scope — mirrors the rest of the platform. */
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    /** Owner: dashboard user XOR headless end-user (constraint below). */
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    endUserId: text("end_user_id").references(() => endUsers.id, { onDelete: "cascade" }),
    /** v1 envelope ciphertext (AES-GCM, keyring-encrypted). */
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    /** Identity claims extracted via the AFPS `auths.{key}.identity_claims` map (§7.4) — `sub`, `email`, … */
    identityClaims: jsonb("identity_claims"),
    /** Granted OAuth scopes — surfaced in the UI for re-consent prompts. */
    scopesGranted: text("scopes_granted")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    needsReconnection: boolean("needs_reconnection").notNull().default(false),
    // Which registered OAuth client minted this connection — a flat client id:
    // the env id of a system client (SYSTEM_INTEGRATIONS) or the
    // `integration_oauth_clients.id` of the org's own per-application client.
    // Pinned so token refresh resolves the SAME client credentials that minted
    // the tokens. Resolved system-first then DB-by-id (mirrors the model-provider
    // credential pattern), so a system id MUST NOT be UUID-shaped.
    //
    // INVARIANT: NULL ⟺ a non-oauth2 auth (api_key / login_secret), which has no
    // OAuth client. Every oauth2 connection carries a non-null client_ref (set
    // by OAuth2Strategy on every connect/reconnect). Enforced at the service
    // layer — a cross-table CHECK on the auth type is not expressible in SQL.
    clientRef: text("client_ref"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // Consecutive token-refresh failures classified as *transient* (network /
    // 5xx / parse — NOT `invalid_grant`, which flips `needsReconnection`
    // immediately). A transient failure on a still-valid token is a no-op for
    // the connection's usability (cached token keeps working), but a token that
    // is expired AND has failed refresh repeatedly is effectively dead while
    // looking healthy. This counter, gated on `expiresAt < now() - grace`,
    // escalates such a connection to `needsReconnection` so the preflight
    // resolver catches it with an actionable cause instead of every run dying
    // opaquely at integration boot. Reset to 0 on any successful credential
    // write (`persistCredentialBundle`).
    refreshFailureCount: integer("refresh_failure_count").notNull().default(0),
    lastRefreshFailureAt: timestamp("last_refresh_failure_at", { withTimezone: true }),
    // User-facing display name, set at creation: the extracted identity
    // (email/login) when available, else "Connexion N" (N = existing connection
    // count + 1 in the same (app, integration, owner) group). Stable for the
    // row's lifetime; user-editable. The UI shows it verbatim — a single source
    // of truth, no render-time fallback gymnastics.
    label: text("label"),
    // Owner-set opt-in: when true, this connection is selectable by
    // any actor of the same application during the run-time fallback
    // resolution (see integration-connection-resolver). Off by default
    // — sharing is explicit consent, never silent.
    sharedWithOrg: boolean("shared_with_org").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // No uniqueness on (packageId, authKey, accountId, app, owner): an
    // actor may hold multiple connections on the same integration auth
    // (even pointing at the same upstream account — it's their call to
    // keep duplicates or clean up). Reconnect / upgrade flows target a
    // specific row via its `id` (threaded through the OAuth state).
    // Covering lookup index so the resolver's per-actor queries stay fast.
    // Column order is (integrationId, applicationId, authKey): the hot
    // reads filter (integrationId, applicationId) — with or without
    // authKey — so applicationId must precede authKey for both shapes to get
    // a full prefix match. Its leftmost prefix (integrationId) also
    // serves package-only scans + the package FK cascade, so no separate
    // single-column package index is needed.
    index("idx_integration_conn_lookup").on(
      table.integrationId,
      table.applicationId,
      table.authKey,
    ),
    index("idx_integration_conn_user")
      .on(table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
    index("idx_integration_conn_end_user")
      .on(table.endUserId)
      .where(sql`${table.endUserId} IS NOT NULL`),
    // applicationId-only scans (FK cascade on app delete) — not covered by
    // the lookup index (which leads with integrationId).
    index("idx_integration_conn_app").on(table.applicationId),
    // Hot path for the fallback resolution: when an actor has no pin
    // and no override, the resolver enumerates own + shared connections
    // for (app, integration, authKey). Partial index keeps the sharing
    // set small.
    index("idx_integration_conn_shared")
      .on(table.applicationId, table.integrationId, table.authKey)
      .where(sql`${table.sharedWithOrg} = true`),
    check(
      "integration_conn_exactly_one_owner",
      sql`(user_id IS NOT NULL AND end_user_id IS NULL) OR (user_id IS NULL AND end_user_id IS NOT NULL)`,
    ),
    // AFPS §7.2 (audit 03c §D-4): manifest auth keys MUST match
    // `^[a-z][a-z0-9_]*$`. The DB mirrors the manifest-side validation
    // already enforced by `@afps-spec/schema` so the wire and the row
    // never disagree (an attacker-crafted INSERT bypassing the API still
    // hits the same gate).
    check("integration_connections_auth_key_valid", sql`"auth_key" ~ '^[a-z][a-z0-9_]*$'`),
  ],
);

/**
 * Phase 1.3 — per-application OAuth2 client registration for integration
 * auths (proposal §4.1.6.1 + spec gap addressed by 1.3 UI).
 *
 * Many integration `auths.{key}` of type `oauth2` need a clientId/secret
 * registered against the upstream IdP before any user can perform the
 * authorization flow. Administrators provide these values once per
 * application via the marketplace detail page; the user-facing connect
 * button then drives the standard PKCE exchange against the manifest's
 * declared `authorizationUrl` / `tokenUrl`.
 *
 * For `tokenAuthMethod = "none"` (public clients), `client_secret` is
 * stored as the empty string — encryption still applies for shape
 * uniformity with private clients. PKCE is mandatory for public clients
 * (enforced at the connect-flow layer).
 *
 * Multi-client: an admin may register **N** custom (BYO-app) clients per
 * `(application, integration, auth)` — mirroring the model-provider pattern
 * (N credentials, one `is_default`, system fallback). The connect resolver
 * picks the `is_default` custom client (else the system client, else the
 * first custom). Two carve-outs are DB-enforced by partial unique indexes:
 *   - `idx_ioc_one_default` → at most one `is_default=true` custom per auth.
 *   - `idx_ioc_one_auto`    → at most one `auto_provisioned=true` client per
 *     auth (the DCR/CIMD machine client — find-or-create idempotence without
 *     the old global UNIQUE).
 *
 * Lifecycle: created by admin (or auto-provisioned via DCR), optionally
 * rotated, deleted when the integration is uninstalled (FK cascade).
 */
export const integrationOauthClients = pgTable(
  "integration_oauth_clients",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    integrationId: text("integration_package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    authKey: text("auth_key").notNull(),
    clientId: text("client_id").notNull(),
    /**
     * v1 envelope ciphertext over `{ client_secret: "..." }`, or the empty
     * string for a public client.
     *
     * Empty means empty — a public client's row carries NO ciphertext, so
     * "does this client have a secret" is a column read rather than a
     * decryption. Rows written before `token_endpoint_auth_method` existed may
     * still hold a ciphertext over an empty secret. Nothing reads that state as
     * a public client any more — the connect and refresh resolvers reject it by
     * name and point at `scripts/maintenance/backfill-public-oauth-clients.ts`,
     * which is the only thing that can canonicalise it (Postgres cannot see
     * through the ciphertext, so no migration can).
     */
    clientSecretEncrypted: text("client_secret_encrypted").notNull(),
    /**
     * Client-authentication method for THIS registered client, overriding the
     * manifest's `auths.{key}.token_endpoint_auth_method`.
     *
     * `NULL` means "not declared — use the manifest's value", which is both
     * the pre-existing behaviour and the default for a confidential client.
     * `'none'` is how an admin declares a PUBLIC client: the app is registered
     * at the provider without a secret and authenticates by `client_id` alone
     * (RFC 6749 §3.2.1 / RFC 7591 §2).
     *
     * A column and not a derivation: "public client" used to be inferred from
     * an empty secret, an inference asserted in three comments and enforced
     * nowhere. It sent `client_secret=` (present but empty) to providers that
     * reject it — Dropbox answered `invalid_client` while Airtable tolerated
     * the equivalent empty Basic header, so the same misconfiguration silently
     * worked for one integration and hard-failed for another. The admin's
     * intent is now stored, not guessed.
     *
     * Widened beyond a boolean deliberately: `NULL` distinguishes "undeclared"
     * from "declared confidential", and the three-value shape can carry a
     * per-client Basic-vs-POST difference that a boolean could not express.
     */
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    /** Optional pre-registered redirect URI; falls back to the platform default at connect time. */
    redirectUri: text("redirect_uri"),
    // Whether this custom (BYO-app) client is the default for new connections.
    // A per-row `is_default` boolean (not an org-level pointer) BECAUSE the
    // default is scoped per `(application, integration, auth)` tuple — unlike the
    // org-scoped model/proxy default, which uses an `organizations.default_*_id`
    // pointer (org scope → pointer). Here, among the N custom clients of an auth
    // at most one is flagged default (DB-enforced by `idx_ioc_one_default`); the
    // connect resolution cascade reads it (default custom → else system → else
    // first custom). New clients are flagged default by the service only when no
    // other custom default exists, so the column baseline is `false`.
    isDefault: boolean("is_default").notNull().default(false),
    // Provenance: `true` for a client minted automatically via DCR/CIMD at
    // connect time (remote MCP public client), `false` for an admin-registered
    // (BYO-app) client. Multi-custom registration is an oauth2-classic feature;
    // an auto-provisioned auth keeps exactly ONE machine client, enforced by the
    // partial unique `idx_ioc_one_auto`, which preserves DCR find-or-create
    // idempotence now that the global UNIQUE is gone.
    autoProvisioned: boolean("auto_provisioned").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // At most one default custom client per (app, integration, auth) — the
    // model-provider one-default invariant, DB-enforced. "Default = system" is
    // simply zero custom rows flagged default (valid under the partial index).
    uniqueIndex("idx_ioc_one_default")
      .on(table.applicationId, table.integrationId, table.authKey)
      .where(sql`${table.isDefault}`),
    // At most one auto-provisioned (DCR/CIMD) client per (app, integration,
    // auth) — replaces the old global UNIQUE for the find-or-create path while
    // leaving classic custom clients free to be N.
    uniqueIndex("idx_ioc_one_auto")
      .on(table.applicationId, table.integrationId, table.authKey)
      .where(sql`${table.autoProvisioned}`),
    // Values are the three methods `@appstrate/connect` implements.
    check(
      "ioc_auth_method_values",
      sql`${table.tokenEndpointAuthMethod} IS NULL OR ${table.tokenEndpointAuthMethod} IN ('client_secret_post', 'client_secret_basic', 'none')`,
    ),
    // Public client IFF no stored ciphertext — the state this column exists to
    // make unrepresentable: a row can no longer claim to be public while
    // holding a secret, nor name a secret-based method while holding none.
    //
    // This does NOT have to wait for the backfill, which was the original
    // reading. A legacy public row is structurally `NULL` + a ciphertext (of an
    // empty secret), which satisfies the second branch — Postgres cannot see
    // through the ciphertext, so it cannot recognise that row as public either
    // way. No existing row violates this, so it lands VALID immediately — and
    // by the same token it can never eliminate one, which is why the legacy
    // read paths were replaced by a loud refusal rather than by a migration.
    // The backfill still runs, to canonicalise those rows' MEANING.
    check(
      "ioc_public_iff_no_secret",
      sql`(${table.tokenEndpointAuthMethod} = 'none' AND ${table.clientSecretEncrypted} = '') OR (${table.tokenEndpointAuthMethod} IS DISTINCT FROM 'none' AND ${table.clientSecretEncrypted} <> '')`,
    ),
    index("idx_integration_oauth_clients_app").on(table.applicationId),
    index("idx_integration_oauth_clients_package").on(table.integrationId),
    // Hot path: the connect resolver + clients list enumerate every custom
    // client for an (app, integration, auth).
    index("idx_integration_oauth_clients_lookup").on(
      table.applicationId,
      table.integrationId,
      table.authKey,
    ),
  ],
);
