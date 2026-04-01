import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  serial,
  uuid,
  index,
  doublePrecision,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { executionStatusEnum } from "./enums.ts";
import { user } from "./auth.ts";
import { applications, endUsers } from "./applications.ts";
import { organizations } from "./organizations.ts";
import { packages, packageVersions } from "./packages.ts";
import { connectionProfiles } from "./connections.ts";

export const executions = pgTable(
  "executions",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id").notNull(),
    userId: text("user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    endUserId: text("end_user_id").references(() => endUsers.id, {
      onDelete: "set null",
    }),
    applicationId: text("application_id").references(() => applications.id, {
      onDelete: "set null",
    }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    status: executionStatusEnum("status").notNull().default("pending"),
    input: jsonb("input"),
    result: jsonb("result"),
    state: jsonb("state"),
    error: text("error"),
    tokensUsed: integer("tokens_used"),
    tokenUsage: jsonb("token_usage"),
    startedAt: timestamp("started_at").defaultNow(),
    completedAt: timestamp("completed_at"),
    duration: integer("duration"),
    connectionProfileId: uuid("connection_profile_id"),
    scheduleId: text("schedule_id"),
    packageVersionId: integer("package_version_id").references(() => packageVersions.id),
    notifiedAt: timestamp("notified_at"),
    readAt: timestamp("read_at"),
    proxyLabel: text("proxy_label"),
    modelLabel: text("model_label"),
    cost: doublePrecision("cost"),
    executionNumber: integer("execution_number"),
  },
  (table) => [
    index("idx_executions_package_id").on(table.packageId),
    index("idx_executions_status").on(table.status),
    index("idx_executions_user_id").on(table.userId),
    index("idx_executions_end_user_id").on(table.endUserId),
    index("idx_executions_application_id").on(table.applicationId),
    index("idx_executions_org_id").on(table.orgId),
    index("idx_executions_notification").on(
      table.userId,
      table.orgId,
      table.notifiedAt,
      table.readAt,
    ),
    check(
      "executions_at_most_one_actor",
      sql`NOT (user_id IS NOT NULL AND end_user_id IS NOT NULL)`,
    ),
  ],
);

export const executionLogs = pgTable(
  "execution_logs",
  {
    id: serial("id").primaryKey(),
    executionId: text("execution_id")
      .notNull()
      .references(() => executions.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").notNull().default("progress"),
    level: text("level").notNull().default("debug"),
    event: text("event"),
    message: text("message"),
    data: jsonb("data"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_execution_logs_execution_id").on(table.executionId),
    index("idx_execution_logs_lookup").on(table.executionId, table.id),
    index("idx_execution_logs_org_id").on(table.orgId),
  ],
);

export const packageMemories = pgTable(
  "package_memories",
  {
    id: serial("id").primaryKey(),
    packageId: text("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    executionId: text("execution_id").references(() => executions.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_package_memories_package_org").on(table.packageId, table.orgId),
    index("idx_package_memories_org_id").on(table.orgId),
  ],
);

export const packageSchedules = pgTable(
  "package_schedules",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    connectionProfileId: uuid("connection_profile_id")
      .notNull()
      .references(() => connectionProfiles.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name"),
    enabled: boolean("enabled").default(true),
    cronExpression: text("cron_expression").notNull(),
    timezone: text("timezone").default("UTC"),
    input: jsonb("input"),
    lastRunAt: timestamp("last_run_at"),
    nextRunAt: timestamp("next_run_at"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_schedules_package_id").on(table.packageId),
    index("idx_schedules_connection_profile_id").on(table.connectionProfileId),
    index("idx_package_schedules_org_id").on(table.orgId),
  ],
);
