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
    // Which registered OAuth client minted this connection — `"system:<id>"`
    // for an env-provided system client (SYSTEM_INTEGRATION_CLIENTS), `"custom"`
    // for the org's own per-application `integration_oauth_clients` row. NULL on
    // rows created before multi-client support; resolved identically to
    // `"custom"` (the legacy single-client lookup). Pinned so token refresh
    // resolves the SAME client credentials that minted the tokens — without it,
    // refresh cannot disambiguate once a system + custom client coexist.
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
 * Lifecycle: created by admin on first OAuth setup, optionally rotated,
 * deleted when the integration is uninstalled (FK cascade).
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
    /** v1 envelope ciphertext over `{ client_secret: "..." }`. Empty for public clients. */
    clientSecretEncrypted: text("client_secret_encrypted").notNull(),
    /** Optional pre-registered redirect URI; falls back to the platform default at connect time. */
    redirectUri: text("redirect_uri"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_integration_oauth_clients_unique").on(
      table.applicationId,
      table.integrationId,
      table.authKey,
    ),
    index("idx_integration_oauth_clients_app").on(table.applicationId),
    index("idx_integration_oauth_clients_package").on(table.integrationId),
  ],
);
