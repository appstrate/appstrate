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
} from "drizzle-orm/pg-core";
import { executionStatusEnum } from "./enums.ts";
import { user } from "./auth.ts";
import { organizations } from "./organizations.ts";
import { packages, packageVersions } from "./packages.ts";

export const executions = pgTable(
  "executions",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
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
  },
  (table) => [
    index("idx_executions_package_id").on(table.packageId),
    index("idx_executions_status").on(table.status),
    index("idx_executions_user_id").on(table.userId),
    index("idx_executions_org_id").on(table.orgId),
    index("idx_executions_notification").on(
      table.userId,
      table.orgId,
      table.notifiedAt,
      table.readAt,
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
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
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
    index("idx_execution_logs_user_id").on(table.userId),
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
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
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
    index("idx_schedules_user_id").on(table.userId),
    index("idx_package_schedules_org_id").on(table.orgId),
  ],
);

export const shareTokens = pgTable(
  "share_tokens",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    token: text("token").notNull().unique(),
    packageId: text("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    manifest: jsonb("manifest"),
    executionId: text("execution_id").references(() => executions.id, { onDelete: "set null" }),
    consumedAt: timestamp("consumed_at"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_share_tokens_token").on(table.token),
    index("idx_share_tokens_package_id").on(table.packageId),
    index("idx_share_tokens_org_id").on(table.orgId),
  ],
);
