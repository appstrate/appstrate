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

// Per-(member, application) sticky default connection profile.
// Cascade in `resolveProfileId`: explicit override → end-user default →
// THIS sticky → app default → user org-level default.
// Absence of a row = no sticky; clearing the sticky deletes the row.
// End-users have their own auto-created default on `connection_profiles`
// itself, so this table is member-only.
export const userApplicationProfiles = pgTable(
  "user_application_profiles",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    connectionProfileId: uuid("profile_id")
      .notNull()
      .references(() => connectionProfiles.id, { onDelete: "cascade" }),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.applicationId] }),
    index("idx_uap_application_id").on(table.applicationId),
    index("idx_uap_profile_id").on(table.connectionProfileId),
  ],
);
