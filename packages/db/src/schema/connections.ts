import {
  pgTable,
  text,
  timestamp,
  boolean,
  jsonb,
  uuid,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth.ts";
import { organizations } from "./organizations.ts";
import { packages } from "./packages.ts";

export const connectionProfiles = pgTable(
  "connection_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_connection_profiles_default")
      .on(table.userId)
      .where(sql`${table.isDefault} = true`),
    index("idx_connection_profiles_user_id").on(table.userId),
  ],
);

export const userPackageProfiles = pgTable(
  "user_package_profiles",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    packageId: text("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => connectionProfiles.id, { onDelete: "cascade" }),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.packageId] }),
    index("idx_user_package_profiles_package_id").on(table.packageId),
  ],
);

export const packageAdminConnections = pgTable(
  "package_admin_connections",
  {
    packageId: text("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id").references(() => connectionProfiles.id, { onDelete: "set null" }),
    connectedAt: timestamp("connected_at").defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.packageId, table.providerId] }),
    index("idx_package_admin_connections_package_id").on(table.packageId),
    index("idx_package_admin_connections_org_id").on(table.orgId),
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
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.providerId, table.orgId] })],
);

// ─── Service connections (user-level OAuth/API tokens, org-scoped) ──
export const serviceConnections = pgTable(
  "service_connections",
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
    rawTokenResponse: jsonb("raw_token_response"),
    metadata: jsonb("metadata").default({}),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_service_connections_unique").on(
      table.profileId,
      table.providerId,
      table.orgId,
    ),
    index("idx_service_connections_profile").on(table.profileId),
    index("idx_service_connections_org_id").on(table.orgId),
  ],
);

export const registryConnections = pgTable(
  "registry_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessTokenEncrypted: text("access_token_encrypted").notNull(),
    registryUsername: text("registry_username").notNull(),
    registryUserId: text("registry_user_id").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [uniqueIndex("idx_registry_connections_user_id").on(table.userId)],
);

export const oauthStates = pgTable(
  "oauth_states",
  {
    state: text("state").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
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
    createdAt: timestamp("created_at").defaultNow(),
    expiresAt: timestamp("expires_at")
      .notNull()
      .default(sql`NOW() + INTERVAL '10 minutes'`),
  },
  (table) => [index("idx_oauth_states_expires").on(table.expiresAt)],
);
