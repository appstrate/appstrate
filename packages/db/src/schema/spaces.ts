// SPDX-License-Identifier: Apache-2.0

import {
  pgTable,
  text,
  timestamp,
  boolean,
  uuid,
  index,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth.ts";
import { organizations } from "./organizations.ts";

export const spaces = pgTable(
  "spaces",
  {
    id: text("id").primaryKey(), // spc_ prefix
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    settings: jsonb("settings").notNull().default({}),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_spaces_org_id").on(table.orgId),
    uniqueIndex("idx_spaces_one_default")
      .on(table.orgId)
      .where(sql`${table.isDefault} = true`),
  ],
);

export const endUsers = pgTable(
  "end_users",
  {
    id: text("id").primaryKey(), // eu_ prefix
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    externalId: text("external_id"),
    name: text("name"),
    email: text("email"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_end_users_external_id")
      .on(table.spaceId, table.externalId)
      .where(sql`${table.externalId} IS NOT NULL`),
    uniqueIndex("idx_end_users_space_email")
      .on(table.spaceId, table.email)
      .where(sql`email IS NOT NULL`),
    index("idx_end_users_space_id").on(table.spaceId),
    index("idx_end_users_org_id").on(table.orgId),
  ],
);
