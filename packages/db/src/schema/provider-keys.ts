// SPDX-License-Identifier: Apache-2.0

import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  uuid,
  index,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations.ts";
import { user } from "./auth.ts";

export const orgProviderKeys = pgTable(
  "org_provider_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    api: text("api").notNull(),
    baseUrl: text("base_url").notNull(),
    apiKeyEncrypted: text("api_key_encrypted").notNull(),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [index("idx_org_provider_keys_org_id").on(t.orgId)],
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
    providerKeyId: uuid("provider_key_id")
      .notNull()
      .references(() => orgProviderKeys.id, { onDelete: "cascade" }),
    input: jsonb("input"),
    contextWindow: integer("context_window"),
    maxTokens: integer("max_tokens"),
    reasoning: boolean("reasoning"),
    cost: jsonb("cost"),
    enabled: boolean("enabled").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
    source: text("source").notNull().default("custom"),
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
