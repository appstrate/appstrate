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
  uniqueIndex,
  doublePrecision,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { runStatusEnum, llmUsageSourceEnum } from "./enums.ts";
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
    // Snake-case keys: matches the wire format produced by every runner
    // (PiRunner emits `input_tokens` / `output_tokens` / … directly from
    // the Pi SDK), the AFPS `tokenUsageSchema` validated on ingestion in
    // `apps/api/src/services/adapters/types.ts`, and the frontend reader
    // in `run-info-tab.tsx`. Do NOT rename to camelCase without a data
    // migration and a coordinated wire-schema bump — the JSONB payloads
    // already in production use snake_case.
    tokenUsage: jsonb("token_usage").$type<{
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
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
    // Unified runner protocol (AFPS runtime event ingestion). Every run — platform
    // container or remote CLI — posts events to POST /api/runs/:id/events over
    // HMAC-signed HTTP. The runs row is the per-run credential store and the
    // sink lifecycle tracker.
    //
    // `run_origin` distinguishes WHO controls the process (we do vs customer
    // does), not which protocol is used — the protocol is the same.
    runOrigin: text("run_origin").notNull().default("platform").$type<"platform" | "remote">(),
    // AES-256-GCM ciphertext of the 32-byte run secret (via @appstrate/connect
    // encryption). Returned once in the run-creation response, then lives
    // encrypted at rest for the event-ingestion middleware to decrypt and
    // verify HMAC signatures against.
    sinkSecretEncrypted: text("sink_secret_encrypted"),
    // Hard cap after which /events rejects. Also the "sink is active" signal.
    sinkExpiresAt: timestamp("sink_expires_at"),
    // Set on finalize (terminal event, /finalize POST, explicit revocation).
    // Presence means the sink is closed; subsequent events reject with 410.
    sinkClosedAt: timestamp("sink_closed_at"),
    // Highest successfully persisted sequence number; drives the ordering
    // buffer fast-path (CAS update on sequence = last_event_sequence + 1).
    lastEventSequence: integer("last_event_sequence").notNull().default(0),
    // Liveness marker — bumped on every event POST and every /sink/extend.
    // The stall watchdog sweeps open-sink rows whose `last_heartbeat_at`
    // slipped past the threshold and routes them through `finalizeRun` as
    // `failed` (same convergence point as natural termination and
    // container-exit synthesis — identical for platform + remote runners).
    lastHeartbeatAt: timestamp("last_heartbeat_at").defaultNow().notNull(),
    // CLI-provided execution environment metadata (os, cli version, git sha,
    // ...). Capped at 16 KiB by the route Zod schema.
    contextSnapshot: jsonb("context_snapshot").$type<Record<string, unknown>>(),
    // Human-friendly label for the runner that triggered this run — CLI host
    // name (`os.hostname()`), GitHub Action workflow descriptor, or any other
    // string the caller supplies via `X-Appstrate-Runner-Name` (cap 120 chars,
    // resolved at INSERT time and never updated). Fallback resolution at
    // INSERT time: explicit header → CLI device name from
    // `cli_refresh_tokens.device_name` (joined via the JWT's `cli_family_id`
    // claim) → null. Denormalized so a run keeps its label even after the CLI
    // session is revoked or the device is renamed.
    runnerName: text("runner_name"),
    // Free-form classifier driving icon selection in the UI: `cli`,
    // `github-action`, or any other tag a future runner declares via
    // `X-Appstrate-Runner-Kind`. Stamped at INSERT alongside `runner_name`
    // and never updated.
    runnerKind: text("runner_kind"),
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
    // Reaper scans only active sinks — cheap partial index.
    index("idx_runs_sink_expires_at")
      .on(table.sinkExpiresAt)
      .where(sql`${table.sinkExpiresAt} IS NOT NULL AND ${table.sinkClosedAt} IS NULL`),
    // Stall-watchdog sweep: scans only open-sink rows ordered by
    // liveness, so the range scan is bounded by the stall threshold.
    index("idx_runs_stall_sweep")
      .on(table.lastHeartbeatAt)
      .where(sql`${table.sinkClosedAt} IS NULL AND ${table.sinkExpiresAt} IS NOT NULL`),
    check(
      "runs_at_most_one_actor",
      sql`NOT (dashboard_user_id IS NOT NULL AND end_user_id IS NOT NULL)`,
    ),
    check("runs_run_origin_valid", sql`run_origin IN ('platform', 'remote')`),
    // Invariant: an open sink row (has an expires_at) must have a secret to
    // verify against. Enforced for every origin so platform and remote share
    // the same ingestion code path without any conditional branches.
    check(
      "runs_open_sink_has_secret",
      sql`sink_expires_at IS NULL OR sink_secret_encrypted IS NOT NULL`,
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

/**
 * Unified agent persistence — one row per piece of cross-run state the agent
 * chooses to keep, regardless of its shape. Single store where `scope` is a
 * first-class dimension.
 *
 * - `kind = 'checkpoint'` — one row per `(package, app, actor)`, upserted
 *   last-write-wins. Used for tactical carry-over like pagination cursors
 *   or "last synced at".
 * - `kind = 'memory'`     — append-only list, bounded at 100 per
 *   `(package, app, actor)` with content capped at 2000 chars. Used for
 *   durable facts — user preferences, API quirks, workflow patterns.
 *
 * The actor columns mirror the `runs` convention: `actor_type ∈
 * {'user', 'end_user', 'shared'}`, `actor_id` NULL iff `actor_type = 'shared'`.
 * Headless applications serving many end-users get per-actor isolation by
 * default; OSS single-tenant stacks can opt into shared rows explicitly.
 *
 * See `docs/adr/ADR-011-checkpoint-unification.md`.
 */
export const packagePersistence = pgTable(
  "package_persistence",
  {
    id: serial("id").primaryKey(),
    packageId: text("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().$type<"checkpoint" | "memory">(),
    actorType: text("actor_type").notNull().$type<"user" | "end_user" | "shared">(),
    actorId: text("actor_id"),
    content: jsonb("content").notNull(),
    runId: text("run_id").references(() => runs.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // Upsert target: at most one checkpoint per (package, app, actor).
    // We index on `COALESCE(actor_id, '__shared__')` rather than the raw
    // column so the shared bucket (NULL actor_id) compares-equal to
    // itself: Postgres + PGlite both treat NULLs as DISTINCT by default,
    // so without the coalesce two `shared` checkpoints for the same
    // (package, app) would both be inserted. The coalesce works on both
    // engines, unlike `NULLS NOT DISTINCT` which is Postgres 15+ only.
    uniqueIndex("pkp_checkpoint_unique")
      .on(
        table.packageId,
        table.applicationId,
        table.actorType,
        sql`(COALESCE(${table.actorId}, '__shared__'))`,
      )
      .where(sql`kind = 'checkpoint'`),
    // Primary read path: getCheckpoint / listMemories.
    index("pkp_lookup").on(
      table.packageId,
      table.applicationId,
      table.kind,
      table.actorType,
      table.actorId,
    ),
    index("pkp_org").on(table.orgId),
    check("pkp_kind_valid", sql`kind IN ('checkpoint', 'memory')`),
    check("pkp_actor_type_valid", sql`actor_type IN ('user', 'end_user', 'shared')`),
    // actor_id NULL iff actor_type = 'shared'.
    check(
      "pkp_actor_id_shape",
      sql`(actor_type = 'shared' AND actor_id IS NULL) OR (actor_type <> 'shared' AND actor_id IS NOT NULL)`,
    ),
  ],
);

/**
 * Unified LLM cost ledger — one row per attributable upstream LLM call,
 * regardless of how it reached the provider. The `source` discriminator
 * separates two emitters:
 *
 *   - `proxy`  : `/api/llm-proxy/*` routes (remote/CLI runners). The
 *                route mints a `request_id` per upstream call — replays
 *                dedup on `request_id`.
 *   - `runner` : `appstrate.metric` events POSTed by an in-run sink (Pi
 *                platform container, in-process PiRunner, …). These
 *                events carry the run's monotonic `sequence`; dedup on
 *                `(run_id, source, sequence)`.
 *
 * `runs.cost` is the cached SUM of this table for that run, written once
 * at `finalizeRun`. Never write to `runs.cost` from anywhere else — this
 * table is the single source of truth for run cost. (`credential_proxy_usage`
 * is an audit log, not a cost ledger — see its header comment.)
 *
 * A call is attributable to exactly one principal: either an API key
 * (`api_key_id`) or a JWT-authenticated user (`user_id`). The `CHECK`
 * constraint enforces the XOR so accounting never double-counts.
 */
export const llmUsage = pgTable(
  "llm_usage",
  {
    id: serial("id").primaryKey(),
    source: llmUsageSourceEnum("source").notNull(),
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
    // the model catalog). Kept alongside `realModel` for audit. Required
    // for proxy rows, optional for runner rows (the runner may not know
    // the preset id; `runs.model_label` is the canonical display name).
    model: text("model"),
    // Upstream model id the proxy actually forwarded — resolved from the
    // preset via `loadModel()`. Optional on runner rows.
    realModel: text("real_model"),
    // Protocol family: "openai-completions", "anthropic-messages", …
    // Optional on runner rows.
    api: text("api"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    durationMs: integer("duration_ms"),
    // Proxy dedup key — one per upstream call minted by the proxy route.
    // Null on runner-source rows (they dedup on run_id instead).
    requestId: text("request_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_llm_usage_org_id").on(table.orgId),
    index("idx_llm_usage_api_key_id").on(table.apiKeyId),
    index("idx_llm_usage_user_id").on(table.userId),
    index("idx_llm_usage_run_id").on(table.runId),
    index("idx_llm_usage_org_created").on(table.orgId, table.createdAt),
    // Proxy-source dedup: request_id is unique across all proxy rows.
    uniqueIndex("uq_llm_usage_proxy_request_id")
      .on(table.requestId)
      .where(sql`source = 'proxy' AND request_id IS NOT NULL`),
    // Runner-source dedup: at most one runner row per run. The metric
    // event carries a running total; the row is written once by whichever
    // path lands first (the metric event handler or the finalize-time
    // fallback). ON CONFLICT DO NOTHING enforces single-write.
    uniqueIndex("uq_llm_usage_runner_run_id")
      .on(table.runId)
      .where(sql`source = 'runner' AND run_id IS NOT NULL`),
    // INSERT invariant: exactly one principal. After FK cleanup (api_key /
    // user deleted) both may become NULL — the row survives for audit /
    // billing retention, so we don't enforce "exactly one" forever.
    check("llm_usage_principal_single", sql`api_key_id IS NULL OR user_id IS NULL`),
    // Source-consistency invariants.
    check("llm_usage_proxy_has_request_id", sql`source <> 'proxy' OR request_id IS NOT NULL`),
    check("llm_usage_runner_has_run_id", sql`source <> 'runner' OR run_id IS NOT NULL`),
  ],
);

/**
 * Per-call audit log of the `/api/credential-proxy/*` routes — one row per
 * upstream provider call proxied server-side for a remote runner. Records
 * provider id, target host, HTTP status, and duration for observability /
 * abuse-detection / per-org telemetry.
 *
 * `cost_usd` is 0 today and excluded from `computeRunCost` — see
 * `apps/api/src/services/credential-proxy-usage.ts` header. When a metered
 * credential provider ships, route its cost rows through `llm_usage` with a
 * new `source` enum value rather than resurrecting a SUM here, so the
 * single-ledger invariant for `runs.cost` is preserved.
 *
 * `request_id` is the dedup key: the credential-proxy route derives one per
 * upstream request; replays of the same request are no-ops via the UNIQUE
 * constraint. Prevents double-counting when a CLI retries.
 */
export const credentialProxyUsage = pgTable(
  "credential_proxy_usage",
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
    applicationId: text("application_id").references(() => applications.id, {
      onDelete: "set null",
    }),
    // Provider id the call hit (e.g. "gmail", "clickup"). Matches the
    // credential-proxy route path parameter.
    providerId: text("provider_id").notNull(),
    // Upstream host for audit (no path/query — avoid logging secrets).
    targetHost: text("target_host"),
    httpStatus: integer("http_status"),
    durationMs: integer("duration_ms"),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    requestId: text("request_id").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_credential_proxy_usage_org_id").on(table.orgId),
    index("idx_credential_proxy_usage_run_id").on(table.runId),
    index("idx_credential_proxy_usage_org_created").on(table.orgId, table.createdAt),
    check("credential_proxy_usage_principal_single", sql`api_key_id IS NULL OR user_id IS NULL`),
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
