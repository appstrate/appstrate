// SPDX-License-Identifier: Apache-2.0

import {
  pgTable,
  text,
  timestamp,
  boolean,
  uuid,
  integer,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { orgRoleEnum, invitationStatusEnum } from "./enums.ts";
import { user } from "./auth.ts";
import { applications } from "./applications.ts";
import { userProviderConnections } from "./connections.ts";

export const organizations = pgTable("organizations", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").unique().notNull(),
  orgSettings: jsonb("org_settings").notNull().default({}),
  createdBy: text("created_by").references(() => user.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const organizationMembers = pgTable(
  "org_members",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: orgRoleEnum("role").notNull(),
    joinedAt: timestamp("joined_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.userId] }),
    index("idx_org_members_user_id").on(table.userId),
  ],
);

export const orgInvitations = pgTable(
  "org_invitations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    token: text("token").notNull().unique(),
    email: text("email").notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    role: orgRoleEnum("role").notNull(),
    status: invitationStatusEnum("status").notNull().default("pending"),
    invitedBy: text("invited_by").references(() => user.id),
    acceptedBy: text("accepted_by").references(() => user.id),
    expiresAt: timestamp("expires_at").notNull(),
    acceptedAt: timestamp("accepted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_org_invitations_token").on(table.token),
    index("idx_org_invitations_org_id").on(table.orgId),
    index("idx_org_invitations_email").on(table.email),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdBy: text("created_by").references(() => user.id),
    expiresAt: timestamp("expires_at"),
    lastUsedAt: timestamp("last_used_at"),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_api_keys_org_id").on(table.orgId),
    index("idx_api_keys_application_id").on(table.applicationId),
    uniqueIndex("idx_api_keys_key_hash").on(table.keyHash),
    index("idx_api_keys_key_prefix").on(table.keyPrefix),
  ],
);

export const orgProxies = pgTable(
  "org_proxies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    urlEncrypted: text("url_encrypted").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
    source: text("source").notNull().default("custom"), // "built-in" | "custom"
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_org_proxies_org_id").on(table.orgId),
    uniqueIndex("idx_org_proxies_one_default")
      .on(table.orgId)
      .where(sql`${table.isDefault} = true`),
  ],
);

export const orgSystemProviderKeys = pgTable(
  "org_system_provider_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    api: text("api").notNull(),
    baseUrl: text("base_url").notNull(),
    apiKeyEncrypted: text("api_key_encrypted"),
    authMode: text("auth_mode", { enum: ["api_key", "oauth"] })
      .notNull()
      .default("api_key"),
    oauthConnectionId: uuid("oauth_connection_id").references(() => userProviderConnections.id, {
      onDelete: "cascade",
    }),
    providerPackageId: text("provider_package_id"),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_org_system_provider_keys_org_id").on(t.orgId),
    index("idx_org_system_provider_keys_oauth_conn").on(t.oauthConnectionId),
    check(
      "org_system_provider_keys_auth_mode_consistency",
      sql`(
        (auth_mode = 'api_key' AND api_key_encrypted IS NOT NULL AND oauth_connection_id IS NULL) OR
        (auth_mode = 'oauth'   AND api_key_encrypted IS NULL     AND oauth_connection_id IS NOT NULL)
      )`,
    ),
  ],
);

/**
 * Unified credentials table for LLM model providers (API-key + OAuth alike).
 *
 * Replaces `org_system_provider_keys` (Phase 8 drop). The `provider_id` column
 * is a free-text registry key (e.g. "codex", "openai") — NOT a FK to
 * `packages.id`. Inference wire format and default base URL are read from the
 * platform registry (`apps/api/src/services/oauth-model-providers/registry.ts`)
 * keyed by `provider_id`. `base_url_override` is honored only for providers
 * whose registry entry has `baseUrlOverridable: true` (e.g. "openai-compatible").
 *
 * The encrypted blob's plaintext is a tagged union:
 *   { kind: "api_key", apiKey: string }
 *   { kind: "oauth",   accessToken, refreshToken, expiresAt, accountId?,
 *                       scopesGranted: string[], needsReconnection: boolean }
 *
 * Decryption goes through `services/model-provider-credentials.loadCredentials`,
 * which fans out to the right code path based on the registry's `authMode`.
 */
export const modelProviderCredentials = pgTable(
  "model_provider_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    providerId: text("provider_id").notNull(),
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    baseUrlOverride: text("base_url_override"),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_model_provider_credentials_org_id").on(t.orgId),
    index("idx_model_provider_credentials_org_provider").on(t.orgId, t.providerId),
  ],
);

export const orgModels = pgTable(
  "org_models",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    api: text("api").notNull(),
    baseUrl: text("base_url").notNull(),
    modelId: text("model_id").notNull(),
    /**
     * UUID of either an `org_system_provider_keys` row (legacy, api-key path)
     * or a `model_provider_credentials` row (new, both paths). The FK is
     * deliberately dropped during the Phase 4 transition — Phase 5 re-adds
     * a strict FK to `model_provider_credentials.id` after the legacy
     * table is fully retired.
     */
    providerKeyId: uuid("provider_key_id").notNull(),
    input: jsonb("input"), // ["text", "image"] | null
    contextWindow: integer("context_window"), // 200000 | null
    maxTokens: integer("max_tokens"), // 16384 | null
    reasoning: boolean("reasoning"), // true | null
    cost: jsonb("cost"), // { input, output, cacheRead, cacheWrite } in $/M tokens | null
    enabled: boolean("enabled").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
    source: text("source").notNull().default("custom"), // "built-in" | "custom"
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_org_models_org_id").on(table.orgId),
    uniqueIndex("idx_org_models_one_default")
      .on(table.orgId)
      .where(sql`${table.isDefault} = true`),
  ],
);
