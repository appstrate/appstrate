// SPDX-License-Identifier: Apache-2.0

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
import { runStatusEnum } from "./enums.ts";
import { user } from "./auth.ts";
import { applications, endUsers } from "./applications.ts";
import { apiKeys, organizations } from "./organizations.ts";
import { packages } from "./packages.ts";
import { connectionProfiles } from "./connections.ts";
import type { RunProviderSnapshot } from "./types.ts";

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    dashboardUserId: text("dashboard_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    endUserId: text("end_user_id").references(() => endUsers.id, {
      onDelete: "set null",
    }),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    status: runStatusEnum("status").notNull().default("pending"),
    input: jsonb("input"),
    result: jsonb("result"),
    state: jsonb("state"),
    error: text("error"),
    tokenUsage: jsonb("token_usage").$type<{
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      totalTokens?: number;
    }>(),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
    duration: integer("duration"),
    connectionProfileId: uuid("connection_profile_id").references(() => connectionProfiles.id, {
      onDelete: "set null",
    }),
    scheduleId: text("schedule_id").references(() => schedules.id, {
      onDelete: "set null",
    }),
    versionLabel: text("version_label"),
    versionDirty: boolean("version_dirty").default(false).notNull(),
    notifiedAt: timestamp("notified_at"),
    readAt: timestamp("read_at"),
    proxyLabel: text("proxy_label"),
    modelLabel: text("model_label"),
    modelSource: text("model_source"),
    cost: doublePrecision("cost"),
    runNumber: integer("run_number"),
    providerProfileIds: jsonb("provider_profile_ids").$type<Record<string, string>>(),
    providerStatuses: jsonb("provider_statuses").$type<RunProviderSnapshot[]>(),
    apiKeyId: text("api_key_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    config: jsonb("config").$type<Record<string, unknown>>(),
    // Snapshot of the agent's @scope/name at run creation time. Survives
    // package rename, delete, or inline-run compaction (where manifest is
    // NULLed). Read by global /api/runs view and UI to display agent name
    // without relying on `packages.manifest.name`.
    agentScope: text("agent_scope"),
    agentName: text("agent_name"),
  },
  (table) => [
    index("idx_runs_package_id").on(table.packageId),
    index("idx_runs_status").on(table.status),
    index("idx_runs_dashboard_user_id").on(table.dashboardUserId),
    index("idx_runs_end_user_id").on(table.endUserId),
    index("idx_runs_application_id").on(table.applicationId),
    index("idx_runs_app_status_started").on(table.applicationId, table.status, table.startedAt),
    index("idx_runs_org_id").on(table.orgId),
    index("idx_runs_notification").on(
      table.dashboardUserId,
      table.orgId,
      table.notifiedAt,
      table.readAt,
    ),
    check(
      "runs_at_most_one_actor",
      sql`NOT (dashboard_user_id IS NOT NULL AND end_user_id IS NOT NULL)`,
    ),
  ],
);

export const runLogs = pgTable(
  "run_logs",
  {
    id: serial("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").notNull().default("progress"),
    level: text("level").notNull().default("debug"),
    event: text("event"),
    message: text("message"),
    data: jsonb("data"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_run_logs_run_id").on(table.runId),
    index("idx_run_logs_lookup").on(table.runId, table.id),
    index("idx_run_logs_org_id").on(table.orgId),
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
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    runId: text("run_id").references(() => runs.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_package_memories_package_app").on(table.packageId, table.applicationId),
    index("idx_package_memories_org_id").on(table.orgId),
    index("idx_package_memories_app_id").on(table.applicationId),
  ],
);

/**
 * Per-call metering of the `/api/llm-proxy/*` routes — one row per
 * upstream LLM request the platform proxied server-side for a remote
 * runner (CLI, GitHub Action, third-party agents).
 *
 * A call is attributable to exactly one principal: either an API key
 * (`api_key_id`) or a JWT-authenticated user (`user_id`). The `CHECK`
 * constraint enforces the XOR so accounting never double-counts.
 *
 * `run_id` is nullable because Phase 3 ships standalone proxy calls
 * (`X-Run-Id` absent). Phase 4's `POST /api/runs/remote` path will
 * propagate the header and populate the column without migration.
 */
export const llmProxyUsage = pgTable(
  "llm_proxy_usage",
  {
    id: serial("id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    apiKeyId: text("api_key_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),
    userId: text("user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    runId: text("run_id").references(() => runs.id, {
      onDelete: "set null",
    }),
    // Preset id the caller asked for (what the CLI / client picked from
    // the model catalog). Kept alongside `realModel` for audit.
    model: text("model").notNull(),
    // Upstream model id the proxy actually forwarded — resolved from the
    // preset via `loadModel()`.
    realModel: text("real_model").notNull(),
    // Protocol family: "openai-completions", "anthropic-messages", …
    api: text("api").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_llm_proxy_usage_org_id").on(table.orgId),
    index("idx_llm_proxy_usage_api_key_id").on(table.apiKeyId),
    index("idx_llm_proxy_usage_user_id").on(table.userId),
    index("idx_llm_proxy_usage_run_id").on(table.runId),
    index("idx_llm_proxy_usage_org_created").on(table.orgId, table.createdAt),
    // INSERT invariant: exactly one principal. After FK cleanup (api_key /
    // user deleted) both may become NULL — the row survives for audit /
    // billing retention, so we don't enforce "exactly one" forever.
    check("llm_proxy_usage_principal_single", sql`api_key_id IS NULL OR user_id IS NULL`),
  ],
);

export const schedules = pgTable(
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
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
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
