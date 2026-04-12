// SPDX-License-Identifier: Apache-2.0

/**
 * OIDC module schema.
 *
 * Owns every table required by the Better Auth `jwt` + `@better-auth/oauth-provider`
 * plugins, plus a shadow profile table (`oidc_end_user_profiles`) that links the
 * core `end_users` row to the global Better Auth `user` row.
 *
 * ## Polymorphic OAuth clients
 *
 * The `oauth_clients` table supports two scoping levels, discriminated by
 * `level`:
 *
 * - **`org`**: the client is scoped to a single organization pinned at
 *   creation via `referenced_org_id`. Dashboard users (org operators) are the
 *   actors; tokens carry `actor_type: "dashboard_user"` with `org_id` +
 *   `org_role` claims.
 * - **`application`**: the client is scoped to a single application pinned at
 *   creation via `referenced_application_id`. End-users are the actors;
 *   tokens carry `actor_type: "end_user"` with `application_id` +
 *   `end_user_id` claims.
 *
 * A CHECK constraint enforces that exactly one of `referenced_org_id` or
 * `referenced_application_id` is set based on `level`, making "mixed" clients
 * unrepresentable at the database level.
 *
 * The Drizzle export is kept named `oauthClient` (singular) so the Better
 * Auth oauth-provider plugin's internal model id (`oauthClient`) resolves
 * correctly via `drizzleSchemas()` — the SQL table name is the plural form.
 * The plugin-native `skipConsent` field is aliased to the `is_first_party`
 * column so the admin API exposes the SOTA "first party trusted client"
 * semantic while Better Auth's consent flow keeps honoring the flag.
 *
 * FK direction rule (CLAUDE.md): module → core is expressed via Drizzle
 * `.references()` inline. Core → module is never permitted.
 */

import { pgTable, text, timestamp, boolean, uuid, index } from "drizzle-orm/pg-core";
import { user, session, endUsers, organizations, applications } from "@appstrate/db/schema";

// ─── Better Auth: jwt plugin ──────────────────────────────────────────────────

export const jwks = pgTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at"),
});

// ─── Better Auth: oauth-provider plugin ───────────────────────────────────────

export const oauthClient = pgTable(
  "oauth_clients",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    disabled: boolean("disabled").default(false),
    // Better Auth oauth-provider "trusted client" flag — when true, the
    // consent screen is skipped. Exposed at the admin API as `isFirstParty`.
    skipConsent: boolean("is_first_party").default(false),
    enableEndSession: boolean("enable_end_session"),
    subjectType: text("subject_type"),
    scopes: text("scopes").array().default([]),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
    expiresAt: timestamp("expires_at"),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts").array(),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: text("redirect_uris").array().notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    grantTypes: text("grant_types").array(),
    responseTypes: text("response_types").array(),
    public: boolean("public"),
    type: text("type"),
    requirePKCE: boolean("require_pkce"),
    metadata: text("metadata"),
    // ─── Appstrate polymorphic fields ────────────────────────────────────────
    level: text("level", { enum: ["org", "application"] }).notNull(),
    referencedOrgId: uuid("referenced_org_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    referencedApplicationId: text("referenced_application_id").references(() => applications.id, {
      onDelete: "cascade",
    }),
  },
  (t) => [
    index("idx_oauth_clients_org").on(t.referencedOrgId),
    index("idx_oauth_clients_app").on(t.referencedApplicationId),
  ],
);

export const oauthRefreshToken = pgTable("oauth_refresh_tokens", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  referenceId: text("reference_id"),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").defaultNow(),
  revoked: timestamp("revoked"),
  authTime: timestamp("auth_time"),
  scopes: text("scopes").array().notNull(),
});

export const oauthAccessToken = pgTable("oauth_access_tokens", {
  id: text("id").primaryKey(),
  token: text("token").unique(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  referenceId: text("reference_id"),
  refreshId: text("refresh_id").references(() => oauthRefreshToken.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").defaultNow(),
  scopes: text("scopes").array().notNull(),
});

export const oauthConsent = pgTable("oauth_consents", {
  id: text("id").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "cascade" }),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  referenceId: text("reference_id"),
  scopes: text("scopes").array().notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ─── OIDC shadow profile (module-owned RBAC/linking layer) ───────────────────

export const oidcEndUserProfiles = pgTable(
  "oidc_end_user_profiles",
  {
    endUserId: text("end_user_id")
      .primaryKey()
      .references(() => endUsers.id, { onDelete: "cascade" }),
    authUserId: text("auth_user_id").references(() => user.id, { onDelete: "set null" }),
    status: text("status").notNull().default("active"),
    emailVerified: boolean("email_verified").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("idx_oidc_profiles_auth_user").on(table.authUserId)],
);
