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

import {
  pgTable,
  text,
  integer,
  timestamp,
  boolean,
  uuid,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { user, session, endUsers, organizations, applications } from "@appstrate/db/schema";

// ─── Better Auth: jwt plugin ──────────────────────────────────────────────────

export const jwks = pgTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at"),
});

// ─── Better Auth: device-authorization plugin ─────────────────────────────────
//
// RFC 8628 Device Authorization Grant — powers `appstrate login` in the
// official CLI. One row per in-flight or approved device code. `deviceCode`
// is the opaque verifier the CLI polls with; `userCode` (`XXXX-XXXX`) is
// the short code the user types into `/activate`. `status` transitions:
// `pending` → `approved` | `denied` (terminal) → row deleted by BA's
// `/device/token` handler once the token is minted. The realm/level guard
// runs in `oidcGuardsPlugin` on `/device/approve` (see `auth/guards.ts`)
// because the BA plugin bypasses `@better-auth/oauth-provider` — its
// default session-mint path doesn't consult `oauth_clients` metadata.

export const deviceCode = pgTable("device_codes", {
  id: text("id").primaryKey(),
  deviceCode: text("device_code").notNull().unique(),
  userCode: text("user_code").notNull().unique(),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at").notNull(),
  status: text("status").notNull(),
  lastPolledAt: timestamp("last_polled_at"),
  pollingInterval: integer("polling_interval"),
  // FK to oauth_clients so pending codes die with the client. BA stores
  // this as a plain string — the FK is Appstrate defense-in-depth.
  clientId: text("client_id").references(() => oauthClient.clientId, {
    onDelete: "cascade",
  }),
  scope: text("scope"),
  // Brute-force lockout counter — incremented by the realm guard on
  // `/device/approve` + `/device/deny`. When it exceeds the threshold
  // (`MAX_APPROVE_ATTEMPTS` in `auth/guards.ts`), the guard flips the
  // row to `status = 'denied'` so no one (attacker or legit user) can
  // approve it anymore — the code is sacrificed and a fresh one must be
  // requested. See migration 0005_device_code_attempts for the full
  // rationale and threat model.
  attempts: integer("attempts").notNull().default(0),
});
// No extra indexes on this table: `device_code` / `user_code` lookups
// go through their UNIQUE B-tree, `client_id` is never used as a query
// predicate (we always resolve it via the PK after finding the row by
// user_code), and expiry is checked inline during polling on the single
// row already fetched. A fresh install typically holds at most a
// handful of pending codes; seq-scan on delete-cascade is cheap enough
// to forgo an FK index.

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
    level: text("level", { enum: ["org", "application", "instance"] }).notNull(),
    referencedOrgId: uuid("referenced_org_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    referencedApplicationId: text("referenced_application_id").references(() => applications.id, {
      onDelete: "cascade",
    }),
    // Org-level auto-provisioning policy: when true, a user signing in through
    // this client who is NOT yet a member of `referenced_org_id` is
    // auto-added to the org with `signup_role`. When false, non-members are
    // rejected upstream (GET guards hide the register/social surfaces and the
    // BA beforeSignup hook blocks orphan user creation). Ignored on
    // application/instance clients — end-user provisioning goes through
    // `resolveOrCreateEndUser` instead. Mutable (unlike `level` /
    // `referenced_*_id`): read via `getClientCached` so updates propagate
    // within one cache TTL (30s).
    allowSignup: boolean("allow_signup").default(false).notNull(),
    // Role assigned on auto-join. `owner` is deliberately excluded at the DB,
    // Zod, and UI layers to prevent self-promotion via a misconfigured client.
    signupRole: text("signup_role", { enum: ["admin", "member", "viewer"] })
      .default("member")
      .notNull(),
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

// ─── Per-application SMTP configuration ──────────────────────────────────────
//
// Stores SMTP credentials scoped to a single application, used by `level=application`
// OAuth clients for verification emails, magic links, and password reset. Row
// absent → email features disabled for that app's OIDC flows (no fallback to
// instance env SMTP — delivering customer emails from the platform domain
// defeats the purpose). Password encrypted at rest via `@appstrate/connect`
// (`CONNECTION_ENCRYPTION_KEY`). ON DELETE CASCADE ensures secrets don't
// outlive the app.
export const applicationSmtpConfigs = pgTable("application_smtp_configs", {
  applicationId: text("application_id")
    .primaryKey()
    .references(() => applications.id, { onDelete: "cascade" }),
  host: text("host").notNull(),
  port: integer("port").notNull(),
  username: text("username").notNull(),
  // AES-256-GCM encrypted JSON blob (base64) via `encryptCredentials({ pass })`.
  passEncrypted: text("pass_encrypted").notNull(),
  // Version tag of the `CONNECTION_ENCRYPTION_KEY` that produced
  // `passEncrypted`. Stamped on every write. Rotation SOP in the module
  // README instructs operators to re-upsert all rows after rotating the key;
  // rows with a stale tag surface as "SMTP not configured" rather than a
  // silent decryption error.
  encryptionKeyVersion: text("encryption_key_version").notNull().default("v1"),
  fromAddress: text("from_address").notNull(),
  fromName: text("from_name"),
  // "auto" → secure=true iff port === 465. "tls" → explicit TLS. "starttls"
  // → opportunistic TLS. "none" → plaintext (dev relays only).
  secureMode: text("secure_mode", { enum: ["auto", "tls", "starttls", "none"] })
    .notNull()
    .default("auto"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Per-application social auth providers ───────────────────────────────────
//
// Stores Google/GitHub OAuth App credentials scoped to a single application,
// consumed by `level=application` OAuth clients so the tenant's login page
// authenticates through the TENANT's OAuth App (branded consent screen,
// tenant-controlled scopes, tenant-owned audit). Row absent → that provider's
// button is hidden on the tenant's login/register pages (no fallback to
// instance env creds, same rule as `application_smtp_configs`). Client secret
// encrypted at rest via `@appstrate/connect` (`CONNECTION_ENCRYPTION_KEY`).
// Composite PK (application_id, provider) allows per-provider granularity —
// a tenant may configure Google today and GitHub tomorrow.
export const applicationSocialProviders = pgTable(
  "application_social_providers",
  {
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["google", "github"] }).notNull(),
    clientId: text("client_id").notNull(),
    // AES-256-GCM encrypted JSON blob (base64) via
    // `encryptCredentials({ clientSecret })`.
    clientSecretEncrypted: text("client_secret_encrypted").notNull(),
    // Version tag of the `CONNECTION_ENCRYPTION_KEY` that produced
    // `clientSecretEncrypted`. See `application_smtp_configs.encryptionKeyVersion`.
    encryptionKeyVersion: text("encryption_key_version").notNull().default("v1"),
    // Optional per-app scope override. When null, the provider's default
    // scope set applies (Google: email/profile/openid, GitHub: user:email).
    scopes: text("scopes").array(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.applicationId, t.provider] })],
);
