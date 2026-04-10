// SPDX-License-Identifier: Apache-2.0

import { pgTable, text, timestamp, boolean, uuid, index, jsonb } from "drizzle-orm/pg-core";

// Scheduling module — owns the package_schedules table.
// FKs to core tables (packages, organizations, applications, connection_profiles)
// are added via raw SQL in migrations (same pattern as @appstrate/cloud).

export const packageSchedules = pgTable(
  "package_schedules",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id").notNull(),
    connectionProfileId: uuid("connection_profile_id").notNull(),
    orgId: uuid("org_id").notNull(),
    applicationId: text("application_id").notNull(),
    name: text("name"),
    enabled: boolean("enabled").default(true).notNull(),
    cronExpression: text("cron_expression").notNull(),
    timezone: text("timezone").default("UTC"),
    input: jsonb("input"),
    lastRunAt: timestamp("last_run_at"),
    nextRunAt: timestamp("next_run_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_schedules_package_id").on(table.packageId),
    index("idx_schedules_connection_profile_id").on(table.connectionProfileId),
    index("idx_package_schedules_org_id").on(table.orgId),
    index("idx_package_schedules_app_id").on(table.applicationId),
  ],
);
