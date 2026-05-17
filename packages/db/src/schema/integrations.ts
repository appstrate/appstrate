// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS integration storage tables (Phase 1.1 — credential layer).
 *
 * Separate from `userProviderConnections` (legacy provider model)
 * because the integration model is keyed differently:
 *
 *   - One integration manifest can declare 1..N auths
 *     (`auths.{key}` — proposal §4.1.1), each independently connected
 *     by the user. Status (`needsReconnection`, `expiresAt`,
 *     `scopesGranted`) is per-auth, not per-integration.
 *
 *   - Each (integration, auth) pair can hold multiple accounts (e.g.
 *     two Google accounts on the same Gmail integration). The
 *     `accountId` discriminator is extracted at connection time via
 *     the manifest's `extractTokenIdentity.accountId` JSONPath.
 *
 *   - Connections are scoped per application (every connect-able
 *     surface in Appstrate is application-scoped — see CLAUDE.md
 *     "Multi-tenant" section), with the owner being either a
 *     dashboard user (`userId`) or a headless end-user
 *     (`endUserId`). The check constraint mirrors `connection_profiles`.
 *
 * The runtime spawn flow (Phase 1.2a) will hit this table once per
 * declared auth at integration boot, decrypt with the same v1 envelope
 * as `userProviderConnections`, and feed
 * `resolveIntegrationCredentials` (packages/connect/integration-credentials.ts).
 */

import {
  pgTable,
  text,
  timestamp,
  boolean,
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
    integrationPackageId: text("integration_package_id")
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
    /** v1 envelope ciphertext (same primitive as `userProviderConnections`). */
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    /** Identity claims extracted via `extractTokenIdentity` — `accountEmail`, …. */
    identityClaims: jsonb("identity_claims"),
    /** Granted OAuth scopes — surfaced in the UI for re-consent prompts. */
    scopesGranted: text("scopes_granted")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    needsReconnection: boolean("needs_reconnection").notNull().default(false),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // One row per (integration, auth key, account, application, owner).
    // The `coalesce` trick keeps the unique constraint usable for both
    // owner types — empty string sentinel for the null side avoids
    // PostgreSQL's "NULLs distinct in unique" caveat.
    uniqueIndex("idx_integration_conn_unique").on(
      table.integrationPackageId,
      table.authKey,
      table.accountId,
      table.applicationId,
      sql`coalesce(${table.userId}, '')`,
      sql`coalesce(${table.endUserId}, '')`,
    ),
    index("idx_integration_conn_user")
      .on(table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
    index("idx_integration_conn_end_user")
      .on(table.endUserId)
      .where(sql`${table.endUserId} IS NOT NULL`),
    index("idx_integration_conn_app").on(table.applicationId),
    index("idx_integration_conn_package").on(table.integrationPackageId),
    check(
      "integration_conn_exactly_one_owner",
      sql`(user_id IS NOT NULL AND end_user_id IS NULL) OR (user_id IS NULL AND end_user_id IS NOT NULL)`,
    ),
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
    integrationPackageId: text("integration_package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    authKey: text("auth_key").notNull(),
    clientId: text("client_id").notNull(),
    /** v1 envelope ciphertext over `{ client_secret: "..." }`. Empty for public clients. */
    clientSecretEncrypted: text("client_secret_encrypted").notNull(),
    /** Optional pre-registered redirect URI; falls back to the platform default at connect time. */
    redirectUri: text("redirect_uri"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_integration_oauth_clients_unique").on(
      table.applicationId,
      table.integrationPackageId,
      table.authKey,
    ),
    index("idx_integration_oauth_clients_app").on(table.applicationId),
    index("idx_integration_oauth_clients_package").on(table.integrationPackageId),
  ],
);
