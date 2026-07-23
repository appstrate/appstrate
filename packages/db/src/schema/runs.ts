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
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { TokenUsage } from "@appstrate/afps-shared/token-usage";
import { runStatusEnum, llmUsageSourceEnum, runOriginEnum, credentialSourceEnum } from "./enums.ts";
import { user } from "./auth.ts";
import { applications, endUsers } from "./applications.ts";
import { apiKeys, organizations, modelProviderCredentials } from "./organizations.ts";
import { packages } from "./packages.ts";
import { chatSessions } from "./chat.ts";

/**
 * Closed shape of the `runs.result` terminal payload written by
 * `finalizeRun` (enforced at the write boundary by `runResultSchema` in
 * `apps/api/src/lib/jsonb-schemas.ts`). `$type<>` only — TS-level, no
 * migration. Deliberately a type ALIAS (not an interface) so it keeps the
 * implicit index signature and stays assignable to the
 * `Record<string, unknown>` consumers downstream (log payloads, hook
 * `extra` bags, …).
 */
export type RunResultPayload = {
  /** Structured output emitted via the `output` tool (schema-validated). */
  output?: unknown;
  /** Deprecated report-tool markdown aggregate, capped at 256 KiB. */
  text?: string;
  /** Present only when `text` was truncated at the cap. */
  text_truncated?: true;
};

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    // Source agent. NULL when the agent has been deleted — the run survives
    // for observability/billing thanks to the `agent_scope` / `agent_name`
    // / `version_label` / `model_label` snapshots stamped at INSERT below.
    // Switched from CASCADE to SET NULL in 0017_decouple_runs_from_packages.sql:
    // before that, deleting an agent wiped its run history (and the cascade
    // also surfaced the llm_usage CHECK violation that 0016 fixes). Keeping
    // a FK at all (instead of dropping it entirely and treating package_id
    // as a free-text snapshot) lets the global runs view LEFT JOIN packages
    // for the alive case and short-circuit on NULL for the deleted case.
    packageId: text("package_id").references(() => packages.id, {
      onDelete: "set null",
    }),
    userId: text("user_id").references(() => user.id, {
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
    result: jsonb("result").$type<RunResultPayload>(),
    checkpoint: jsonb("checkpoint"),
    // `error` stores the human-readable `RunError.message` only. The
    // runtime `RunError` shape (`code`, `message`, `stack`, `context`,
    // `timestamp`) IS round-tripped at the runtime/runner boundary —
    // sinks observing run-event ingestion see the full structured
    // payload — but only `message` is persisted on the row today. The
    // structured fields are intentionally dropped at write time
    // (`apps/api/src/services/run-event-ingestion.ts` extracts
    // `result.error?.message`); widening this column to `jsonb` is
    // tracked as a follow-up so the migration + OpenAPI bump + frontend
    // reader update can land together. Until then, OpenAPI's
    // `Run.error: string` reflects what the database actually exposes.
    error: text("error"),
    // Snake-case keys: matches the wire format produced by every runner
    // (PiRunner emits `input_tokens` / `output_tokens` / … directly from
    // the Pi SDK), the AFPS `tokenUsageSchema` validated on ingestion in
    // `apps/api/src/services/adapters/types.ts`, and the frontend reader
    // in `run-info-tab.tsx`. Do NOT rename to camelCase without a data
    // migration and a coordinated wire-schema bump — the JSONB payloads
    // already in production use snake_case.
    tokenUsage: jsonb("token_usage").$type<TokenUsage>(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    duration: integer("duration"),
    scheduleId: text("schedule_id").references(() => schedules.id, {
      onDelete: "set null",
    }),
    // Version vocabulary across the pipeline: the REQUESTED selector
    // (exact version / dist-tag / semver range / "draft") is persisted as
    // `version_ref` here and on the wire, and travels the service layer as
    // `versionSpec` (the PackageCatalog.resolve() parameter). The RESOLVED
    // concrete version stamped on the run is `versionLabel` everywhere.
    versionLabel: text("version_label"),
    versionRef: text("version_ref").default("draft").notNull(),
    proxyLabel: text("proxy_label"),
    modelLabel: text("model_label"),
    modelSource: text("model_source"),
    cost: doublePrecision("cost"),
    runNumber: integer("run_number"),
    // Per-run integration connection overrides — the caller's explicit
    // choice at run kickoff (e.g. "for this run, use my Gmail-Boulot
    // not my Gmail-Perso"). Shape: { "@scope/integration": "<connection_id>" }.
    // Loses to admin pin. Resolution snapshot lives in resolvedConnections
    // below. Flat (no per-authKey nesting): one connection per integration.
    connectionOverrides: jsonb("connection_overrides").$type<Record<string, string>>(),
    // Snapshot of the resolver output at run start — what connection
    // was actually used per integration, plus the source
    // ("admin_pin" | "run_override" | "schedule_override" | "member_pin" | "fallback_*").
    // Audit trail: a run's identity in the upstream provider logs maps
    // back through this column even after pins/connections are mutated.
    resolvedConnections:
      jsonb("resolved_connections").$type<
        Record<
          string,
          { connectionId: string; source: string; label?: string | null; accountId?: string | null }
        >
      >(),
    // Snapshot of the integration manifest VERSION resolved per declared
    // integration at run kickoff (#686). Shape:
    // { "@scope/integration": { version: "1.4.2" | null, source: "version" | "draft" | "system" } }.
    // Frozen here so every manifest read for THIS run — the kickoff spawn
    // spec AND the long-lived runtime credential/MITM-refresh path — resolves
    // the same version, never re-deriving against a catalog that may gain a
    // newer published version mid-run. `version: null` for `draft`/`system`
    // sources (no `package_versions` row). The sibling of `resolvedConnections`
    // for the manifest-version axis; absent integrations fall back to draft.
    resolvedIntegrationVersions: jsonb("resolved_integration_versions").$type<
      Record<string, { version: string | null; source: "version" | "draft" | "system" }>
    >(),
    apiKeyId: text("api_key_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    config: jsonb("config").$type<Record<string, unknown>>(),
    // Per-run override layer — the delta the caller sent on top of
    // `application_packages.config`. `config` above is the resolved
    // (deep-merged) snapshot; `configOverride` is the raw delta so the
    // UI can badge "default vs override" and "Re-run with these settings"
    // can replay the exact same delta. Null when the run used persisted
    // defaults verbatim.
    configOverride: jsonb("config_override").$type<Record<string, unknown>>(),
    // Per-run dependency version overrides (#666). Shape:
    // { "@scope/skill": "draft" | "<semver|dist-tag>" }. Run-scoped escape
    // hatch out of the published-only resolution: `"draft"` pulls that
    // dependency's mutable working copy (skill edit loop), any other value
    // replaces the manifest pin for that dependency. Persisted as the audit
    // trail so a run that consumed draft bytes is never mistaken for a
    // reproducible one. Null when the run resolved the manifest pins verbatim.
    dependencyOverrides: jsonb("dependency_overrides").$type<Record<string, string>>(),
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
    runOrigin: runOriginEnum("run_origin").notNull().default("platform"),
    // AES-256-GCM ciphertext of the 32-byte run secret (via @appstrate/connect
    // encryption). Returned once in the run-creation response, then lives
    // encrypted at rest for the event-ingestion middleware to decrypt and
    // verify HMAC signatures against.
    sinkSecretEncrypted: text("sink_secret_encrypted"),
    // Hard cap after which /events rejects. Also the "sink is active" signal.
    sinkExpiresAt: timestamp("sink_expires_at", { withTimezone: true }),
    // Set on finalize (terminal event, /finalize POST, explicit revocation).
    // Presence means the sink is closed; subsequent events reject with 410.
    sinkClosedAt: timestamp("sink_closed_at", { withTimezone: true }),
    // Highest successfully persisted sequence number; drives the ordering
    // buffer fast-path (CAS update on sequence = last_event_sequence + 1).
    lastEventSequence: integer("last_event_sequence").notNull().default(0),
    // Liveness marker — bumped on every event POST and every /sink/extend.
    // The stall watchdog sweeps open-sink rows whose `last_heartbeat_at`
    // slipped past the threshold and routes them through `finalizeRun` as
    // `failed` (same convergence point as natural termination and
    // container-exit synthesis — identical for platform + remote runners).
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).defaultNow().notNull(),
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
    // Open-set classifier driving icon selection in the UI. Known values
    // emitted by first-party runners: `cli`, `github-action`. The column
    // is intentionally `text` (not pgEnum) so third-party runners can
    // declare their own kind via `X-Appstrate-Runner-Kind` without a DB
    // migration; the format is enforced at the auth/header boundary by
    // `lib/runner-context.ts` (lowercase ASCII, 1–32 chars, kebab/digits/
    // letters only). Unknown kinds render with the generic "remote" badge
    // in the dashboard. Stamped at INSERT alongside `runner_name` and
    // never updated.
    runnerKind: text("runner_kind"),
    /**
     * The `model_provider_credentials` row this run is allowed to fetch
     * tokens for (via `/internal/oauth-token/:credentialId`). Snapshotted
     * at run creation time. Stamped only for platform-origin runs that
     * resolve to an OAuth model provider — null otherwise (API-key model,
     * remote-origin run, scheduler synthesis pre-resolution).
     *
     * Defense-in-depth: without this binding, a leaked run token could be
     * used to enumerate ALL OAuth credentials of the run's org. With it,
     * the resolver rejects any credentialId not pinned at run start.
     */
    modelCredentialId: uuid("model_credential_id").references(() => modelProviderCredentials.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    index("idx_runs_package_id").on(table.packageId),
    index("idx_runs_status").on(table.status),
    index("idx_runs_user_id").on(table.userId),
    index("idx_runs_end_user_id").on(table.endUserId),
    // Per-agent run history (the hottest list path): WHERE package_id = ?
    // ORDER BY started_at DESC. Also serves getLastRun / getRecentRuns /
    // nextRunNumber. A backward scan satisfies the DESC
    // sort, so a plain composite suffices.
    index("idx_runs_package_started").on(table.packageId, table.startedAt),
    // schedule_id is LEFT JOINed on every enriched run list and the FK
    // SET NULL on schedule delete scans runs by it — partial index keeps it
    // tiny (most runs are ad-hoc, schedule_id NULL).
    index("idx_runs_schedule_id")
      .on(table.scheduleId)
      .where(sql`${table.scheduleId} IS NOT NULL`),
    // Application-scoped lookups (incl. the FK cascade on app delete) are
    // served by the leftmost prefix of idx_runs_app_status_started — no
    // separate single-column applicationId index needed.
    index("idx_runs_app_status_started").on(table.applicationId, table.status, table.startedAt),
    // Global runs list with NO status filter: WHERE application_id = ?
    // ORDER BY started_at DESC. The three-column index above needs a
    // status equality to serve the sort, so the unfiltered path keeps a
    // two-column twin.
    index("idx_runs_app_started").on(table.applicationId, table.startedAt),
    // MAX(run_number) per package (nextRunNumber) becomes a 1-row
    // backward index probe instead of an aggregate scan.
    index("idx_runs_package_run_number").on(table.packageId, table.runNumber),
    // FK cascade scans: api_keys / model_provider_credentials deletes
    // SET NULL on runs by these columns. Partial — most runs carry
    // neither, so the indexes stay tiny.
    index("idx_runs_api_key_id")
      .on(table.apiKeyId)
      .where(sql`${table.apiKeyId} IS NOT NULL`),
    index("idx_runs_model_credential_id")
      .on(table.modelCredentialId)
      .where(sql`${table.modelCredentialId} IS NOT NULL`),
    index("idx_runs_org_id").on(table.orgId),
    // Referenced target of the composite tenant-integrity FK on
    // `llm_usage(run_id, org_id)` (CRIT-07): Postgres needs a unique index
    // covering exactly these columns for the FK to attach. Trivially valid —
    // `id` alone is the PK, so `(id, org_id)` can never collide.
    uniqueIndex("uq_runs_id_org_id").on(table.id, table.orgId),
    // Reaper scans only active sinks — cheap partial index.
    index("idx_runs_sink_expires_at")
      .on(table.sinkExpiresAt)
      .where(sql`${table.sinkExpiresAt} IS NOT NULL AND ${table.sinkClosedAt} IS NULL`),
    // Stall-watchdog sweep: scans only open-sink rows ordered by
    // liveness, so the range scan is bounded by the stall threshold.
    index("idx_runs_stall_sweep")
      .on(table.lastHeartbeatAt)
      .where(sql`${table.sinkClosedAt} IS NULL AND ${table.sinkExpiresAt} IS NOT NULL`),
    check("runs_at_most_one_actor", sql`NOT (user_id IS NOT NULL AND end_user_id IS NOT NULL)`),
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
    data: jsonb("data").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_run_logs_run_id").on(table.runId),
    index("idx_run_logs_lookup").on(table.runId, table.id),
    index("idx_run_logs_org_id").on(table.orgId),
    // `level` has a fixed domain in the app (appendRunLog) but `type` is
    // intentionally open-ended (progress/event kinds modules invent freely).
    check("run_logs_level_valid", sql`level IN ('debug', 'info', 'warn', 'error')`),
  ],
);

/**
 * Unified agent persistence — one row per piece of cross-run state the agent
 * chooses to keep, regardless of its shape. The shape collapses two
 * orthogonal dimensions instead of an enum:
 *
 * - `key` — nullable string. When set, the row is upsert-by-key (single
 *   slot per `(package, app, actor, key)`); when null, the row is append-
 *   only. Today the only named slot is `'checkpoint'`; archive memories
 *   leave `key` null.
 * - `pinned` — when true, the row is rendered into the agent's system
 *   prompt on every run. When false, the row only surfaces if the agent
 *   calls `recall_memory`. Checkpoints are pinned by default; memories
 *   default to false.
 *
 * Mapping from the legacy `kind` enum (pre-0011):
 *   `kind='checkpoint'` ≡ `key='checkpoint'`, `pinned=true`.
 *   `kind='memory'`     ≡ `key IS NULL`,      `pinned=false`.
 *
 * Actor columns mirror the `runs` convention: `actor_type ∈
 * {'user', 'end_user', 'shared'}`, `actor_id` NULL iff `actor_type='shared'`.
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
    key: text("key"),
    pinned: boolean("pinned").notNull().default(false),
    actorType: text("actor_type").notNull().$type<"user" | "end_user" | "shared">(),
    actorId: text("actor_id"),
    content: jsonb("content").notNull(),
    runId: text("run_id").references(() => runs.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Upsert target for named slots. The partial WHERE keeps archive rows
    // (`key IS NULL`) out of the index entirely. COALESCE on actor_id is
    // load-bearing across PG and PGlite — see migration 0011 for context.
    uniqueIndex("pkp_key_unique")
      .on(
        table.packageId,
        table.applicationId,
        table.actorType,
        sql`(COALESCE(${table.actorId}, '__shared__'))`,
        table.key,
      )
      .where(sql`key IS NOT NULL`),
    // Primary read paths: getCheckpoint / listMemories / listPinned /
    // recall_memory all narrow on (package, app, actor) first.
    index("pkp_lookup").on(
      table.packageId,
      table.applicationId,
      table.actorType,
      table.actorId,
      table.key,
      table.pinned,
    ),
    index("pkp_org").on(table.orgId),
    // FK cascade scan: run delete SET NULLs package_persistence.run_id.
    // Partial — most rows have no run attribution.
    index("pkp_run_id")
      .on(table.runId)
      .where(sql`${table.runId} IS NOT NULL`),
    check("pkp_actor_type_valid", sql`actor_type IN ('user', 'end_user', 'shared')`),
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
 * `runs.cost` is the cached SUM of this table for that run. It is
 * refreshed on two paths: the throttled `run_metric` broadcaster
 * (during streaming, so a mid-run refresh sees the latest value) and
 * `finalizeRun` (terminal write). Both writers use a monotonic guard
 * (`UPDATE … WHERE cost IS NULL OR cost < new`) so the value never
 * regresses. This table remains the single source of truth — `runs.cost`
 * is only a cache of `SUM(llm_usage.cost_usd)`. (`credential_proxy_usage`
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
    // Was: onDelete: "set null". Switched to cascade to resolve a schema-level
    // contradiction with the `llm_usage_runner_has_run_id` check constraint
    // below: that check forbids NULL run_id on rows where source='runner', but
    // the SET NULL cascade tries to NULL exactly that column when a run is
    // deleted. Net effect was that any DELETE /api/packages/agents/{scope}/{name}
    // on a package whose runs had emitted runner-source llm_usage rows threw a
    // CHECK violation, surfaced as a generic 500 with no detail (cf BUGS-EVO §1.2).
    // CASCADE is the right semantics: an llm_usage row is solidary of its run
    // (no analytical value if the run is gone), and cascading the delete
    // satisfies both the FK and the runner-has-run-id invariant.
    runId: text("run_id").references(() => runs.id, {
      onDelete: "cascade",
    }),
    // Chat attribution — set on rows metered for a chat turn (source='proxy',
    // run_id NULL). Cascades with the session, mirroring the run_id FK above:
    // a ledger row has no analytical value once its context is gone. A row is
    // attributable to at most one context — see the run_id/chat_session_id
    // single-context check below.
    chatSessionId: text("chat_session_id").references(() => chatSessions.id, {
      onDelete: "cascade",
    }),
    // Preset id the caller asked for (what the CLI / client picked from
    // the model catalog). Kept alongside `realModel` for audit. Required
    // for proxy rows, optional for runner rows (the runner may not know
    // the preset id; `runs.model_label` is the canonical display name).
    model: text("model"),
    // Upstream model id the proxy actually forwarded — resolved from the
    // preset via `loadModel()`. Optional on runner rows. SERVER-SIDE ONLY —
    // for an aliased model this is the hidden backing id; never serialize it
    // on any caller-facing surface (route, DTO, SSE, webhook) —
    // `listLlmUsage` deliberately never selects real_model/api. Same
    // for `api` below (backing protocol family).
    realModel: text("real_model"),
    // Protocol family: "openai-completions", "anthropic-messages", …
    // Optional on runner rows.
    api: text("api"),
    // Which credential set reached the upstream provider: platform-provided
    // ("system") or the org's own key/subscription ("org"). Nullable: every
    // new row is stamped, but rows predating this column stay NULL. Historical
    // run rows are backfilled from `runs.model_source`; chat / un-attributed
    // rows stay NULL (a downstream consumer treats NULL as non-attributable).
    credentialSource: credentialSourceEnum("credential_source"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    durationMs: integer("duration_ms"),
    // Proxy dedup key — one per upstream call minted by the proxy route.
    // Null on runner-source rows (they dedup on run_id instead).
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_llm_usage_org_id").on(table.orgId),
    index("idx_llm_usage_api_key_id").on(table.apiKeyId),
    index("idx_llm_usage_user_id").on(table.userId),
    index("idx_llm_usage_run_id").on(table.runId),
    index("idx_llm_usage_chat_session_id").on(table.chatSessionId),
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
    // Tenant-integrity FK (CRIT-07): a ledger row's `run_id` is inseparable
    // from its `org_id` — a row attributed to a run MUST carry that run's own
    // org, so a caller-supplied run id can never bill spend onto another
    // tenant's run. NULL `run_id` rows (un-attributed proxy calls) pass (MATCH
    // SIMPLE). NOTE: created `NOT VALID` in migration 0020 (Drizzle cannot
    // express NOT VALID) so existing rows are never scanned at apply time;
    // enforcement applies to every INSERT/UPDATE from then on. Migration 0021
    // detaches mismatched legacy rows, then `VALIDATE CONSTRAINT`s it.
    foreignKey({
      name: "llm_usage_run_id_org_id_fk",
      columns: [table.runId, table.orgId],
      foreignColumns: [runs.id, runs.orgId],
    }).onDelete("cascade"),
    // Tenant-integrity FK for chat attribution — mirror of the CRIT-07 run FK
    // above: a ledger row's `chat_session_id` is inseparable from its `org_id`,
    // so a caller-supplied session id can never attribute spend onto another
    // tenant's session. NULL `chat_session_id` rows pass (MATCH SIMPLE). Also
    // created NOT VALID in the migration (Drizzle cannot express NOT VALID) so
    // existing rows are never scanned at apply time. ON DELETE CASCADE mirrors
    // the single-column `chat_session_id` FK above.
    foreignKey({
      name: "llm_usage_chat_session_id_org_id_fk",
      columns: [table.chatSessionId, table.orgId],
      foreignColumns: [chatSessions.id, chatSessions.orgId],
    }).onDelete("cascade"),
    // INSERT invariant: exactly one principal. After FK cleanup (api_key /
    // user deleted) both may become NULL — the row survives for audit /
    // billing retention, so we don't enforce "exactly one" forever.
    check("llm_usage_principal_single", sql`api_key_id IS NULL OR user_id IS NULL`),
    // Source-consistency invariants.
    check("llm_usage_proxy_has_request_id", sql`source <> 'proxy' OR request_id IS NOT NULL`),
    check("llm_usage_runner_has_run_id", sql`source <> 'runner' OR run_id IS NOT NULL`),
    // Attribution is to at most one context: a ledger row belongs to a run OR
    // a chat session, never both.
    check("llm_usage_context_single", sql`run_id IS NULL OR chat_session_id IS NULL`),
  ],
);

/**
 * Per-call audit log of the `/api/credential-proxy/*` routes — one row per
 * upstream provider call proxied server-side for a remote runner. Records
 * provider id, target host, HTTP status, and duration for observability /
 * abuse-detection / per-org telemetry.
 *
 * No cost column: this is an audit ledger, not a billing ledger. When a
 * metered credential provider ships, route its cost rows through `llm_usage`
 * with a new `source` enum value rather than adding a SUM here, so the
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
    // Integration id the call hit (e.g. "@appstrate/gmail"). Matches the
    // credential-proxy `X-Integration-Id` request header.
    integrationId: text("integration_id").notNull(),
    // Upstream host for audit (no path/query — avoid logging secrets).
    targetHost: text("target_host"),
    httpStatus: integer("http_status"),
    durationMs: integer("duration_ms"),
    requestId: text("request_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_credential_proxy_usage_org_id").on(table.orgId),
    index("idx_credential_proxy_usage_run_id").on(table.runId),
    index("idx_credential_proxy_usage_org_created").on(table.orgId, table.createdAt),
    // FK cascade targets: api_keys / user / applications deletes SET NULL
    // rows by these columns — without indexes each delete seq-scans the
    // audit log.
    index("idx_credential_proxy_usage_api_key_id").on(table.apiKeyId),
    index("idx_credential_proxy_usage_user_id").on(table.userId),
    index("idx_credential_proxy_usage_application_id").on(table.applicationId),
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
    // Actor the scheduled run executes as. Exactly one of userId / endUserId is
    // set; there is no org-level/system schedule principal.
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    endUserId: text("end_user_id").references(() => endUsers.id, {
      onDelete: "cascade",
    }),
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
    input: jsonb("input").$type<Record<string, unknown>>(),
    // Per-schedule override layer — frozen at schedule creation/edit and
    // deep-merged with the application's persisted config every time the
    // schedule fires. Mirrors the per-run override pipeline (POST /run
    // body) so a schedule is "a recurring run with frozen overrides".
    // Argo CronWorkflow inherit-with-override semantics.
    configOverride: jsonb("config_override").$type<Record<string, unknown>>(),
    modelIdOverride: text("model_id_override"),
    proxyIdOverride: text("proxy_id_override"),
    // Version pin. Either a literal label ("1.2.3") or a dist-tag
    // ("latest", "next"). Resolved at fire time the same way the run
    // route resolves `?version=`.
    versionOverride: text("version_override"),
    // Per-schedule integration connection overrides — frozen at schedule
    // creation/edit (mirrors `configOverride`). Same shape as
    // `runs.connectionOverrides`. Loses to admin pin at fire time.
    connectionOverrides: jsonb("connection_overrides").$type<Record<string, string>>(),
    // Per-schedule dependency version overrides — frozen at schedule
    // creation/edit, forwarded to each fired run's `runs.dependencyOverrides`
    // (#666/#686). Shape: { "@scope/dep": "draft" | "<semver|dist-tag>" }.
    // Keys may name a declared skill OR integration dependency; `"draft"` opts
    // that dependency into its working copy for the dev edit loop, any other
    // value replaces the manifest pin. Mirrors `runs.dependencyOverrides`.
    dependencyOverrides: jsonb("dependency_overrides").$type<Record<string, string>>(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_schedules_package_id").on(table.packageId),
    index("idx_schedules_user_id").on(table.userId),
    index("idx_schedules_end_user_id").on(table.endUserId),
    index("idx_package_schedules_org_id").on(table.orgId),
    index("idx_package_schedules_app_id").on(table.applicationId),
    check(
      "package_schedules_exactly_one_actor",
      sql`(user_id IS NOT NULL) <> (end_user_id IS NOT NULL)`,
    ),
  ],
);
