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

export const applications = pgTable(
  "applications",
  {
    id: text("id").primaryKey(), // app_ prefix
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    settings: jsonb("settings").notNull().default({}),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_applications_org_id").on(table.orgId),
    uniqueIndex("idx_applications_one_default")
      .on(table.orgId)
      .where(sql`${table.isDefault} = true`),
  ],
);

export const endUsers = pgTable(
  "end_users",
  {
    id: text("id").primaryKey(), // eu_ prefix
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    externalId: text("external_id"),
    name: text("name"),
    email: text("email"),
    metadata: jsonb("metadata"),
    // ─── OIDC Identity fields ───
    authUserId: text("auth_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("active"), // active | pending_verification | suspended
    emailVerified: boolean("email_verified").notNull().default(false),
    // ─── Timestamps ───
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_end_users_external_id")
      .on(table.applicationId, table.externalId)
      .where(sql`${table.externalId} IS NOT NULL`),
    uniqueIndex("idx_end_users_app_email")
      .on(table.applicationId, table.email)
      .where(sql`email IS NOT NULL`),
    uniqueIndex("idx_end_users_app_auth_user")
      .on(table.applicationId, table.authUserId)
      .where(sql`${table.authUserId} IS NOT NULL`),
    index("idx_end_users_application_id").on(table.applicationId),
    index("idx_end_users_org_id").on(table.orgId),
  ],
);
