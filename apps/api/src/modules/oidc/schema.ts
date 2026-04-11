// SPDX-License-Identifier: Apache-2.0

/**
 * OIDC module schema.
 *
 * Owns every table required by the Better Auth `jwt` + `@better-auth/oauth-provider`
 * plugins, plus a shadow profile table (`oidc_end_user_profiles`) that links the
 * core `end_users` row to the global Better Auth `user` row. The core `end_users`
 * table is NEVER touched by this module — all OIDC-specific fields live on the
 * shadow table.
 *
 * FK direction rule (CLAUDE.md): module → core is expressed via Drizzle
 * `.references()` inline. Core → module is never permitted.
 */

import { pgTable, text, timestamp, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { user, session, endUsers } from "@appstrate/db/schema";

// ─── Better Auth: jwt plugin ──────────────────────────────────────────────────

export const jwks = pgTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at"),
});

// ─── Better Auth: oauth-provider plugin ───────────────────────────────────────

export const oauthClient = pgTable("oauth_client", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull().unique(),
  clientSecret: text("client_secret"),
  disabled: boolean("disabled").default(false),
  skipConsent: boolean("skip_consent"),
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
  // Invariant: `referenceId` and `metadata.applicationId` must stay equal.
  // `referenceId` is what module code reads directly (branding, admin CRUD);
  // `metadata.applicationId` is what Better Auth's `customAccessTokenClaims`
  // receives (the plugin does not forward `referenceId` to the closure).
  // Always write both via `buildOauthClientApplicationBinding()`.
  referenceId: text("reference_id"),
  metadata: text("metadata"),
});

export const oauthRefreshToken = pgTable("oauth_refresh_token", {
  id: text("id").primaryKey(),
  token: text("token").notNull(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id),
  referenceId: text("reference_id"),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").defaultNow(),
  revoked: timestamp("revoked"),
  authTime: timestamp("auth_time"),
  scopes: text("scopes").array().notNull(),
});

export const oauthAccessToken = pgTable("oauth_access_token", {
  id: text("id").primaryKey(),
  token: text("token").unique(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
  userId: text("user_id").references(() => user.id),
  referenceId: text("reference_id"),
  refreshId: text("refresh_id").references(() => oauthRefreshToken.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").defaultNow(),
  scopes: text("scopes").array().notNull(),
});

export const oauthConsent = pgTable("oauth_consent", {
  id: text("id").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "cascade" }),
  userId: text("user_id").references(() => user.id),
  referenceId: text("reference_id"),
  scopes: text("scopes").array().notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ─── OIDC shadow profile (module-owned RBAC/linking layer) ───────────────────
//
// A per-end-user record that links the core `end_users` row to a global Better
// Auth `user`. Status flows through the OIDC verification pipeline; core runs
// filtering still happens strictly on end_users.id (Phase 0 invariant).

export const oidcEndUserProfiles = pgTable(
  "oidc_end_user_profiles",
  {
    endUserId: text("end_user_id")
      .primaryKey()
      .references(() => endUsers.id, { onDelete: "cascade" }),
    authUserId: text("auth_user_id").references(() => user.id, { onDelete: "set null" }),
    // 'active' | 'pending_verification' | 'suspended'
    status: text("status").notNull().default("active"),
    emailVerified: boolean("email_verified").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_oidc_profiles_auth_user").on(table.authUserId),
    // A single global auth identity may have multiple end-user profiles (one per app),
    // but never two profiles for the same auth user against the same end_users row.
    uniqueIndex("idx_oidc_profiles_end_user_unique").on(table.endUserId),
  ],
);
