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
import { endUsers } from "./applications.ts";
import { organizations } from "./organizations.ts";
import { packages } from "./packages.ts";

export const connectionProfiles = pgTable(
  "connection_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    endUserId: text("end_user_id").references(() => endUsers.id, {
      onDelete: "cascade",
    }),
    orgId: uuid("org_id").references(() => organizations.id, {
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
    index("idx_connection_profiles_org_id").on(table.orgId),
    check(
      "connection_profiles_exactly_one_owner",
      sql`(
        (user_id IS NOT NULL AND end_user_id IS NULL AND org_id IS NULL) OR
        (user_id IS NULL AND end_user_id IS NOT NULL AND org_id IS NULL) OR
        (user_id IS NULL AND end_user_id IS NULL AND org_id IS NOT NULL)
      )`,
    ),
  ],
);

export const userPackageProfiles = pgTable(
  "user_package_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    endUserId: text("end_user_id").references(() => endUsers.id, {
      onDelete: "cascade",
    }),
    packageId: text("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => connectionProfiles.id, { onDelete: "cascade" }),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_user_package_profiles_member")
      .on(table.userId, table.packageId)
      .where(sql`${table.userId} IS NOT NULL`),
    uniqueIndex("idx_user_package_profiles_end_user")
      .on(table.endUserId, table.packageId)
      .where(sql`${table.endUserId} IS NOT NULL`),
    index("idx_user_package_profiles_package_id").on(table.packageId),
    check(
      "user_package_profiles_exactly_one_actor",
      sql`(user_id IS NOT NULL AND end_user_id IS NULL) OR (user_id IS NULL AND end_user_id IS NOT NULL)`,
    ),
  ],
);

// ─── Org profile provider bindings (delegation: org profile → user profile) ──
export const orgProfileProviderBindings = pgTable(
  "org_profile_provider_bindings",
  {
    orgProfileId: uuid("org_profile_id")
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
    primaryKey({ columns: [table.orgProfileId, table.providerId] }),
    index("idx_org_profile_bindings_source").on(table.sourceProfileId),
    index("idx_org_profile_bindings_user").on(table.boundByUserId),
  ],
);

// ─── Provider credentials (per-org secrets, keyed by providerId) ────
export const providerCredentials = pgTable(
  "provider_credentials",
  {
    providerId: text("provider_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    credentialsEncrypted: text("credentials_encrypted"),
    enabled: boolean("enabled").notNull().default(false),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.providerId, table.orgId] })],
);

// ─── User provider connections (user-level OAuth/API tokens, org-scoped) ──
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
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    scopesGranted: text("scopes_granted")
      .array()
      .default(sql`'{}'::text[]`),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_user_provider_connections_unique").on(
      table.profileId,
      table.providerId,
      table.orgId,
    ),
    index("idx_user_provider_connections_profile").on(table.profileId),
    index("idx_user_provider_connections_org_id").on(table.orgId),
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
