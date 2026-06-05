// SPDX-License-Identifier: Apache-2.0

/**
 * OIDC tables — centralized into the core schema (formerly owned by the OIDC
 * module). The system migration pipeline creates them at boot; they exist
 * regardless of whether the OIDC module is loaded in `MODULES`. Behavior
 * (routes, Better Auth plugins, RBAC, realm resolver) stays in
 * `apps/api/src/modules/oidc`.
 *
 * Backs the Better Auth `jwt` + `@better-auth/oauth-provider` +
 * device-authorization plugins, plus a shadow profile table
 * (`oidc_end_user_profiles`) linking the core `end_users` row to the global
 * Better Auth `user` row, and per-application SMTP / social-provider config.
 *
 * The Drizzle export stays named `oauthClient` (singular) so the Better Auth
 * oauth-provider plugin's internal model id (`oauthClient`) resolves via the
 * core schema barrel (`packages/db/src/auth.ts` spreads `import * as schema`).
 * `skipConsent` is aliased to the `is_first_party` column.
 *
 * Raw-SQL CHECK constraints from the module's migrations are reproduced here
 * via Drizzle `check()` so regen keeps them. The `oauth_clients_level_immutable`
 * BEFORE UPDATE trigger (not expressible in Drizzle) is carried in the
 * adoption migration `000N_fold_oidc_tables.sql`.
 */

import {
  pgTable,
  text,
  integer,
  timestamp,
  boolean,
  uuid,
  index,
  primaryKey,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user, session } from "./auth.ts";
import { endUsers, applications } from "./applications.ts";
import { organizations } from "./organizations.ts";

// ─── Better Auth: jwt plugin ──────────────────────────────────────────────────

export const jwks = pgTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at"),
});

// ─── Better Auth: device-authorization plugin (RFC 8628) ──────────────────────

export const deviceCode = pgTable("device_codes", {
  id: text("id").primaryKey(),
  deviceCode: text("device_code").notNull().unique(),
  userCode: text("user_code").notNull().unique(),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at").notNull(),
  status: text("status").notNull(),
  lastPolledAt: timestamp("last_polled_at"),
  pollingInterval: integer("polling_interval"),
  clientId: text("client_id").references(() => oauthClient.clientId, {
    onDelete: "cascade",
  }),
  scope: text("scope"),
  attempts: integer("attempts").notNull().default(0),
});

// ─── Better Auth: oauth-provider plugin ───────────────────────────────────────

export const oauthClient = pgTable(
  "oauth_clients",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    disabled: boolean("disabled").default(false),
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
    level: text("level", { enum: ["org", "application", "instance"] }).notNull(),
    referencedOrgId: uuid("referenced_org_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    referencedApplicationId: text("referenced_application_id").references(() => applications.id, {
      onDelete: "cascade",
    }),
    allowSignup: boolean("allow_signup").default(false).notNull(),
    signupRole: text("signup_role", { enum: ["admin", "member", "viewer"] })
      .default("member")
      .notNull(),
  },
  (t) => [
    index("idx_oauth_clients_org").on(t.referencedOrgId),
    index("idx_oauth_clients_app").on(t.referencedApplicationId),
    // Raw-SQL CHECKs preserved verbatim from the module's 0000/0001 migrations.
    check(
      "oauth_clients_level_check",
      sql`(level = 'org' AND referenced_org_id IS NOT NULL AND referenced_application_id IS NULL) OR (level = 'application' AND referenced_application_id IS NOT NULL AND referenced_org_id IS NULL) OR (level = 'instance' AND referenced_org_id IS NULL AND referenced_application_id IS NULL)`,
    ),
    check("oauth_clients_signup_role_check", sql`signup_role IN ('admin', 'member', 'viewer')`),
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

// ─── CLI refresh tokens (issue #165) ──────────────────────────────────────────

export const cliRefreshToken = pgTable(
  "cli_refresh_tokens",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    familyId: text("family_id").notNull(),
    // Self-referential FK expressed via foreignKey() (column ref resolves only
    // inside the callback). Matches `ON DELETE SET NULL` from 0005.
    parentId: text("parent_id"),
    scope: text("scope"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    usedAt: timestamp("used_at"),
    revokedAt: timestamp("revoked_at"),
    revokedReason: text("revoked_reason"),
    deviceName: text("device_name"),
    userAgent: text("user_agent"),
    createdIp: text("created_ip"),
    lastUsedIp: text("last_used_ip"),
    lastUsedAt: timestamp("last_used_at"),
  },
  (t) => [
    index("idx_cli_refresh_tokens_family").on(t.familyId),
    index("idx_cli_refresh_tokens_user").on(t.userId),
    foreignKey({
      columns: [t.parentId],
      foreignColumns: [t.id],
      name: "cli_refresh_tokens_parent_id_fkey",
    }).onDelete("set null"),
  ],
);

// ─── OIDC shadow profile ─────────────────────────────────────────────────────

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

// ─── Per-application SMTP configuration ──────────────────────────────────────

export const applicationSmtpConfigs = pgTable(
  "application_smtp_configs",
  {
    applicationId: text("application_id")
      .primaryKey()
      .references(() => applications.id, { onDelete: "cascade" }),
    host: text("host").notNull(),
    port: integer("port").notNull(),
    username: text("username").notNull(),
    passEncrypted: text("pass_encrypted").notNull(),
    encryptionKeyVersion: text("encryption_key_version").notNull().default("v1"),
    fromAddress: text("from_address").notNull(),
    fromName: text("from_name"),
    secureMode: text("secure_mode", { enum: ["auto", "tls", "starttls", "none"] })
      .notNull()
      .default("auto"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  () => [
    check(
      "application_smtp_configs_secure_mode_check",
      sql`secure_mode IN ('auto', 'tls', 'starttls', 'none')`,
    ),
  ],
);

// ─── Per-application social auth providers ───────────────────────────────────

export const applicationSocialProviders = pgTable(
  "application_social_providers",
  {
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["google", "github"] }).notNull(),
    clientId: text("client_id").notNull(),
    clientSecretEncrypted: text("client_secret_encrypted").notNull(),
    encryptionKeyVersion: text("encryption_key_version").notNull().default("v1"),
    scopes: text("scopes").array(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.applicationId, t.provider] }),
    check("application_social_providers_provider_check", sql`provider IN ('google', 'github')`),
  ],
);
