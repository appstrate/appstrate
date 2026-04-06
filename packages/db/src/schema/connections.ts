// SPDX-License-Identifier: Apache-2.0

import {
  pgTable,
  text,
  timestamp,
  boolean,
  uuid,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth.ts";
import { applications, endUsers } from "./applications.ts";
import { organizations } from "./organizations.ts"; // used by userProviderConnections + oauthStates
import { packages } from "./packages.ts";

export const connectionProfiles = pgTable(
  "connection_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    endUserId: text("end_user_id").references(() => endUsers.id, {
      onDelete: "cascade",
    }),
    applicationId: text("application_id").references(() => applications.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_connection_profiles_default")
      .on(table.userId)
      .where(sql`${table.isDefault} = true AND ${table.userId} IS NOT NULL`),
    uniqueIndex("idx_connection_profiles_default_end_user")
      .on(table.endUserId)
      .where(sql`${table.isDefault} = true AND ${table.endUserId} IS NOT NULL`),
    index("idx_connection_profiles_user_id").on(table.userId),
    index("idx_connection_profiles_end_user_id").on(table.endUserId),
    index("idx_connection_profiles_app_id").on(table.applicationId),
    check(
      "connection_profiles_exactly_one_owner",
      sql`(
        (user_id IS NOT NULL AND end_user_id IS NULL AND application_id IS NULL) OR
        (user_id IS NULL AND end_user_id IS NOT NULL AND application_id IS NULL) OR
        (user_id IS NULL AND end_user_id IS NULL AND application_id IS NOT NULL)
      )`,
    ),
  ],
);

// Per-provider profile overrides: (actor, agent, provider) → profile
export const userAgentProviderProfiles = pgTable(
  "user_agent_provider_profiles",
  {
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    endUserId: text("end_user_id").references(() => endUsers.id, {
      onDelete: "cascade",
    }),
    packageId: text("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => connectionProfiles.id, { onDelete: "cascade" }),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_ufpp_member")
      .on(table.userId, table.packageId, table.providerId)
      .where(sql`${table.userId} IS NOT NULL`),
    uniqueIndex("idx_ufpp_end_user")
      .on(table.endUserId, table.packageId, table.providerId)
      .where(sql`${table.endUserId} IS NOT NULL`),
    index("idx_ufpp_package_id").on(table.packageId),
    index("idx_ufpp_profile_id").on(table.profileId),
    check(
      "ufpp_exactly_one_actor",
      sql`(user_id IS NOT NULL AND end_user_id IS NULL) OR (user_id IS NULL AND end_user_id IS NOT NULL)`,
    ),
  ],
);

// ─── App profile provider bindings (delegation: app profile → user profile) ──
export const appProfileProviderBindings = pgTable(
  "app_profile_provider_bindings",
  {
    appProfileId: uuid("app_profile_id")
      .notNull()
      .references(() => connectionProfiles.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    sourceProfileId: uuid("source_profile_id")
      .notNull()
      .references(() => connectionProfiles.id, { onDelete: "cascade" }),
    boundByUserId: text("bound_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.appProfileId, table.providerId] }),
    index("idx_app_profile_bindings_source").on(table.sourceProfileId),
    index("idx_app_profile_bindings_user").on(table.boundByUserId),
  ],
);

// ─── Application provider credentials (per-app admin credentials) ──
export const applicationProviderCredentials = pgTable(
  "application_provider_credentials",
  {
    id: uuid("id").defaultRandom().notNull().unique(),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    providerId: text("provider_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.applicationId, table.providerId] }),
    index("idx_app_provider_creds_provider").on(table.providerId),
    index("idx_app_provider_creds_app_id").on(table.applicationId),
  ],
);

// ─── User provider connections (user-level OAuth/API tokens, org-scoped) ──
// Connection profiles (user and org) are independent of applications.
// Connections from different apps accumulate on the same profile — each connection
// is tagged with a providerCredentialId linking it to one application's credentials.
// The unique index on (profileId, providerId, orgId, providerCredentialId) allows
// one connection per provider per app per profile.
export const userProviderConnections = pgTable(
  "user_provider_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => connectionProfiles.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    providerCredentialId: uuid("provider_credential_id")
      .notNull()
      .references(() => applicationProviderCredentials.id, { onDelete: "cascade" }),
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    scopesGranted: text("scopes_granted")
      .array()
      .default(sql`'{}'::text[]`),
    needsReconnection: boolean("needs_reconnection").default(false).notNull(),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_user_provider_connections_unique").on(
      table.profileId,
      table.providerId,
      table.orgId,
      table.providerCredentialId,
    ),
    index("idx_user_provider_connections_profile").on(table.profileId),
    index("idx_user_provider_connections_profile_provider").on(table.profileId, table.providerId),
    index("idx_user_provider_connections_org_id").on(table.orgId),
    index("idx_user_provider_connections_cred_id").on(table.providerCredentialId),
    index("idx_user_provider_connections_org_provider").on(table.orgId, table.providerId),
  ],
);

export const oauthStates = pgTable(
  "oauth_states",
  {
    state: text("state").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    endUserId: text("end_user_id").references(() => endUsers.id, {
      onDelete: "cascade",
    }),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => connectionProfiles.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    codeVerifier: text("code_verifier").notNull(),
    oauthTokenSecret: text("oauth_token_secret"),
    authMode: text("auth_mode").notNull().default("oauth2"),
    scopesRequested: text("scopes_requested")
      .array()
      .default(sql`'{}'::text[]`),
    redirectUri: text("redirect_uri").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at")
      .notNull()
      .default(sql`NOW() + INTERVAL '10 minutes'`),
  },
  (table) => [
    index("idx_oauth_states_expires").on(table.expiresAt),
    check(
      "oauth_states_exactly_one_actor",
      sql`(user_id IS NOT NULL AND end_user_id IS NULL) OR (user_id IS NULL AND end_user_id IS NOT NULL)`,
    ),
  ],
);
