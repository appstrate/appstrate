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
 * Better Auth `user` row, and per-space SMTP / social-provider config.
 *
 * The Drizzle export stays named `oauthClient` (singular) so the Better Auth
 * oauth-provider plugin's internal model id (`oauthClient`) resolves via the
 * core schema barrel (`packages/db/src/auth.ts` spreads `import * as schema`).
 * The same holds for every export below whose name is a plugin model id
 * (`oauthResource`, `oauthClientResource`, `oauthClientAssertion`, …): the
 * adapter addresses a table by its EXPORT KEY and a column by its PROPERTY
 * NAME, never by the SQL name, so renaming either breaks the mapping.
 * `skipConsent` is aliased to the `is_first_party` column.
 *
 * From 1.7.3 that mapping is checked: the drizzle adapter introspects this
 * object at boot and on the first auth request, and a field the provider writes
 * with no column here raises `SchemaMismatchError` and rejects auth traffic.
 * Adding a plugin means adding its tables here in the same change.
 *
 * Raw-SQL CHECK constraints from the module's migrations are reproduced here
 * via Drizzle `check()` so regen keeps them. The `oauth_clients_level_immutable`
 * BEFORE UPDATE trigger (not expressible in Drizzle) is carried in the
 * adoption migration `000N_fold_oidc_tables.sql`.
 */

import {
  pgTable,
  jsonb,
  text,
  integer,
  timestamp,
  boolean,
  uuid,
  index,
  uniqueIndex,
  primaryKey,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { SpaceAssignment } from "@appstrate/core/permissions";
import { user, session } from "./auth.ts";
import { endUsers, spaces } from "./spaces.ts";
import { organizations } from "./organizations.ts";

// ─── Better Auth: jwt plugin ──────────────────────────────────────────────────

export const jwks = pgTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  // Signing algorithm and, for EC/OKP keys, the curve. The jwt plugin reads
  // them to pick a key without parsing `public_key`, so a keyset holding more
  // than one algorithm resolves by column.
  alg: text("alg"),
  crv: text("crv"),
});

// ─── Better Auth: device-authorization plugin (RFC 8628) ──────────────────────

export const deviceCode = pgTable("device_codes", {
  id: text("id").primaryKey(),
  deviceCode: text("device_code").notNull().unique(),
  userCode: text("user_code").notNull().unique(),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  status: text("status").notNull(),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
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
    // Identifier of the client-metadata document a CIMD client was registered
    // from — the discovery URL's stable key, not the `client_id`.
    clientDiscoveryId: text("client_discovery_id"),
    disabled: boolean("disabled").default(false),
    skipConsent: boolean("is_first_party").default(false),
    enableEndSession: boolean("enable_end_session"),
    subjectType: text("subject_type"),
    scopes: text("scopes").array().default([]),
    /** Scopes reachable through the `client_credentials` grant only. */
    clientCredentialsScopes: text("client_credentials_scopes").array().default([]),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
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
    // OIDC back-channel logout (RP-initiated logout's server-to-server half).
    backchannelLogoutUri: text("backchannel_logout_uri"),
    backchannelLogoutSessionRequired: boolean("backchannel_logout_session_required"),
    // Also the public/confidential discriminator: `none` IS a public client.
    // There is no separate boolean — Better Auth requires PKCE off the back of
    // this value alone.
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    // `web` | `native` (OIDC Dynamic Registration §2). Gates which redirect
    // URIs a registration may declare: only `native` accepts loopback and
    // custom-scheme callbacks.
    applicationType: text("application_type"),
    // Client JWK Set, inline or by reference — the keys a `private_key_jwt`
    // client authenticates with.
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    grantTypes: text("grant_types").array(),
    responseTypes: text("response_types").array(),
    requirePKCE: boolean("require_pkce"),
    dpopBoundAccessTokens: boolean("dpop_bound_access_tokens").default(false),
    // Opaque tenant key Better Auth partitions clients by. Unused here — the
    // platform partitions on `level` + `referenced_*` below — but the provider
    // writes it, so the column must exist.
    referenceId: text("reference_id"),
    metadata: text("metadata"),
    // ─── Appstrate polymorphic fields ────────────────────────────────────────
    // Defaults to `instance` so self-registered clients (RFC 7591 DCR /
    // CIMD) — which Better Auth inserts without the platform's polymorphic
    // discriminator — land as instance-level public clients (no org/space
    // reference, satisfying the level CHECK below). Admin-managed creation
    // always sets `level` explicitly, so the default never applies there.
    level: text("level", { enum: ["org", "space", "instance"] })
      .notNull()
      .default("instance"),
    referencedOrgId: uuid("referenced_org_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    referencedSpaceId: text("referenced_space_id").references(() => spaces.id, {
      onDelete: "cascade",
    }),
    allowSignup: boolean("allow_signup").default(false).notNull(),
    /** Explicit space grants applied only on the first organization signup. */
    signupSpaceAssignments: jsonb("signup_space_assignments")
      .$type<ReadonlyArray<SpaceAssignment>>()
      .notNull()
      .default([]),
    /**
     * Org role assigned on OIDC auto-provisioning — it writes straight into
     * `org_members.role`, so it shares the org-role vocabulary. The CHECK below
     * enforces the same three values.
     */
    signupRole: text("signup_role", { enum: ["admin", "member", "guest"] })
      .default("member")
      .notNull(),
  },
  (t) => [
    index("idx_oauth_clients_org").on(t.referencedOrgId),
    index("idx_oauth_clients_space").on(t.referencedSpaceId),
    // Raw-SQL CHECKs preserved verbatim from the module's 0000/0001 migrations.
    check(
      "oauth_clients_level_check",
      sql`(level = 'org' AND referenced_org_id IS NOT NULL AND referenced_space_id IS NULL) OR (level = 'space' AND referenced_space_id IS NOT NULL AND referenced_org_id IS NULL) OR (level = 'instance' AND referenced_org_id IS NULL AND referenced_space_id IS NULL)`,
    ),
    check("oauth_clients_signup_role_check", sql`signup_role IN ('admin', 'member', 'guest')`),
  ],
);

export const oauthRefreshToken = pgTable(
  "oauth_refresh_tokens",
  {
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
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    revoked: timestamp("revoked", { withTimezone: true }),
    authTime: timestamp("auth_time", { withTimezone: true }),
    scopes: text("scopes").array().notNull(),
    // RFC 8707 resource indicators (Better Auth 1.7+): the audiences this token
    // was issued for. Optional — first-party flows that pass no `resource` leave
    // it null.
    resources: text("resources").array(),
    // The `claims` request parameter (OIDC Core §5.5) carried forward, so a
    // refresh mints a userinfo payload with the same claims the user consented to.
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    // The authorization code this token descends from — the join that lets one
    // revocation reach every token minted from one authorization.
    authorizationCodeId: text("authorization_code_id"),
    // RFC 9449 DPoP proof-of-possession confirmation (`cnf`) claim.
    confirmation: jsonb("confirmation"),
    // Rotation replay detection (RFC 9700 §4.14.2): once rotated, a replay of the
    // consumed token within the window replays the encrypted response instead of
    // minting a second family — a network retry stays idempotent while a stolen
    // token still fails after the window.
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: timestamp("rotation_replay_expires_at", { withTimezone: true }),
  },
  (t) => [
    // Replaying an authorization code deletes every token minted from it, by
    // this column, on both token tables.
    index("idx_oauth_refresh_tokens_auth_code").on(t.authorizationCodeId),
  ],
);

export const oauthAccessToken = pgTable(
  "oauth_access_tokens",
  {
    id: text("id").primaryKey(),
    token: text("token").unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    refreshId: text("refresh_id").references(() => oauthRefreshToken.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    scopes: text("scopes").array().notNull(),
    // RFC 8707 resource indicators (Better Auth 1.7+) — see oauth_refresh_tokens.
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    authorizationCodeId: text("authorization_code_id"),
    // Revocation instant, not a flag: introspection distinguishes "never issued"
    // from "revoked at T", and the row is kept until it expires.
    revoked: timestamp("revoked", { withTimezone: true }),
    // RFC 9449 DPoP proof-of-possession confirmation (`cnf`) claim.
    confirmation: jsonb("confirmation"),
  },
  (t) => [index("idx_oauth_access_tokens_auth_code").on(t.authorizationCodeId)],
);

export const oauthConsent = pgTable("oauth_consents", {
  id: text("id").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "cascade" }),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  referenceId: text("reference_id"),
  scopes: text("scopes").array().notNull(),
  // RFC 8707 resource indicators (Better Auth 1.7+) — the resources the user
  // consented the client to access.
  resources: text("resources").array(),
  // The userinfo claims (OIDC Core §5.5) this consent covers, alongside the
  // scopes — a later request for a wider claim set re-prompts.
  requestedUserInfoClaims: text("requested_user_info_claims").array(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// ─── Better Auth: OAuth protected resources (RFC 8707) ────────────────────────
//
// A protected resource the authorization server issues access tokens for.
// `identifier` is the value clients send as the `resource` parameter, and it —
// not `id` — is what `oauth_client_resources` references, so a resource can be
// re-keyed without touching its links.
//
// Every policy column is nullable on purpose: null means "inherit the
// plugin-level default at issuance time", which lets an operator override one
// resource without re-seeding the rest.

export const oauthResource = pgTable("oauth_resources", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("access_token_ttl"),
  refreshTokenTtl: integer("refresh_token_ttl"),
  signingAlgorithm: text("signing_algorithm"),
  signingKeyId: text("signing_key_id"),
  allowedScopes: text("allowed_scopes").array(),
  // Extra JWT claims minted into tokens for this resource. Reserved claims
  // (RFC 9068 §2.2) are rejected server-side, not here.
  customClaims: jsonb("custom_claims"),
  dpopBoundAccessTokensRequired: boolean("dpop_bound_access_tokens_required").default(false),
  disabled: boolean("disabled").default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  // Bumped whenever the policy above changes, so an already-minted token can be
  // told apart from one issued under the current policy.
  policyVersion: integer("policy_version").default(1),
  metadata: jsonb("metadata"),
});

// Join table — which clients may request which resources. Authoritative only
// when the plugin runs with `enforcePerClientResources`; otherwise every client
// reaches every enabled resource. The unique pair is load-bearing: the linkage
// check assumes one row per pair, and a concurrent duplicate insert is meant to
// fail on the constraint so the endpoint can answer "already linked".
export const oauthClientResource = pgTable(
  "oauth_client_resources",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    resourceId: text("resource_id").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_oauth_client_resources_client").on(t.clientId),
    index("idx_oauth_client_resources_resource").on(t.resourceId),
    uniqueIndex("uq_oauth_client_resources_pair").on(t.clientId, t.resourceId),
    // Both FKs are named explicitly: drizzle's derived name for the resource
    // one is 64 bytes, one past Postgres' 63-byte limit, so it would be
    // TRUNCATED at creation and every later `DROP CONSTRAINT` by the declared
    // name would 42704 (the beta.24 failure mode — see migration 0055).
    foreignKey({
      columns: [t.clientId],
      foreignColumns: [oauthClient.clientId],
      name: "oauth_client_resources_client_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.resourceId],
      foreignColumns: [oauthResource.identifier],
      name: "oauth_client_resources_resource_id_fk",
    }).onDelete("cascade"),
  ],
);

// Single-use record for `private_key_jwt` client assertion `jti` values. The id
// is a digest of the assertion identifier, so a replay collides on the primary
// key and the insert fails atomically — including across replicas. `expires_at`
// says when the row is safe to sweep, not when it stops blocking; nothing
// prunes it yet, so rows accumulate like `verification` does.
export const oauthClientAssertion = pgTable("oauth_client_assertions", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
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
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
    deviceName: text("device_name"),
    userAgent: text("user_agent"),
    createdIp: text("created_ip"),
    lastUsedIp: text("last_used_ip"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_oidc_profiles_auth_user").on(table.authUserId),
    // Closed vocabulary (migration 0051). `active` is the only value production
    // code writes, but the column is NOT dead: `modules/oidc/auth/strategy.ts`
    // rejects every end-user token whose profile is not `active`, which makes
    // this the one lever that revokes an end-user WITHOUT deleting the
    // identity. The CHECK turns "an UPDATE to 'suspended' works" from folklore
    // into a contract, and rejects the typo that would lock someone out
    // silently.
    check("oidc_end_user_profiles_status_valid", sql`status IN ('active', 'suspended')`),
  ],
);

// ─── Per-space SMTP configuration ────────────────────────────────────────────

export const spaceSmtpConfigs = pgTable(
  "space_smtp_configs",
  {
    spaceId: text("space_id")
      .primaryKey()
      .references(() => spaces.id, { onDelete: "cascade" }),
    host: text("host").notNull(),
    port: integer("port").notNull(),
    username: text("username").notNull(),
    passEncrypted: text("pass_encrypted").notNull(),
    fromAddress: text("from_address").notNull(),
    fromName: text("from_name"),
    secureMode: text("secure_mode", { enum: ["auto", "tls", "starttls", "none"] })
      .notNull()
      .default("auto"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check(
      "space_smtp_configs_secure_mode_check",
      sql`secure_mode IN ('auto', 'tls', 'starttls', 'none')`,
    ),
  ],
);

// ─── Per-space social auth providers ─────────────────────────────────────────

export const spaceSocialProviders = pgTable(
  "space_social_providers",
  {
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["google", "github"] }).notNull(),
    clientId: text("client_id").notNull(),
    clientSecretEncrypted: text("client_secret_encrypted").notNull(),
    scopes: text("scopes").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.provider] }),
    check("space_social_providers_provider_check", sql`provider IN ('google', 'github')`),
  ],
);
