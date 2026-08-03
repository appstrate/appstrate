// SPDX-License-Identifier: Apache-2.0

import { sql as drizzleSql } from "drizzle-orm";
import type { Db } from "./client.ts";
import type { PricingStatus } from "./pricing-status.ts";

/**
 * Wire payload for `run_metric` PG NOTIFY broadcasts.
 *
 * Fired application-side (not from a trigger) after persisting an
 * `appstrate.metric` event so the running cumulative cost can be
 * computed from the unified `llm_usage` ledger and bundled with the
 * notification — a trigger would only see one row at a time and
 * couldn't sum across the run.
 *
 * Snake-case keys mirror the existing `run_update` / `run_log_insert`
 * channels so the realtime subscriber's snake-to-camel mapper handles
 * all three identically.
 */
export interface RunMetricNotifyPayload {
  /** The run id (matches `subscriber.filter.runId`). */
  run_id: string;
  /** Owning org (cross-tenant isolation gate). */
  org_id: string;
  /** Owning application (cross-app isolation gate). */
  application_id: string;
  /** Agent id, used by the per-agent runs SSE stream filter. */
  package_id: string;
  /** Cumulative token usage as last reported by the runner. */
  token_usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  } | null;
  /** Running aggregate of `llm_usage.cost_usd` for this run, in USD. */
  cost_so_far: number;
  /**
   * Pricing provenance of {@link cost_so_far}, over the SAME ledger rows. Rides
   * along because the number alone is ambiguous: without it a RUNNING run on a
   * model nothing could price streams a confident `$0.0000` until it
   * terminates, and only then flips to "unpriced" from the cached
   * `runs.cost_pricing_status`. NULL when no row of the run carries a status.
   */
  cost_pricing_status: PricingStatus | null;
}

/**
 * Broadcast a metric update on the `run_metric` PG NOTIFY channel.
 *
 * Fire-and-forget: errors are intentionally surfaced to the caller so
 * the ingestion path can log + drop them — a missing notification must
 * never fail the persistence write that came before it.
 *
 * The payload is JSON-encoded inline; postgres truncates NOTIFY
 * payloads at 8 KB but ours is bounded by the four `token_usage`
 * integers, a float and a one-word status, well under that ceiling.
 */
export async function notifyRunMetric(db: Db, payload: RunMetricNotifyPayload): Promise<void> {
  await db.execute(drizzleSql`SELECT pg_notify('run_metric', ${JSON.stringify(payload)})`);
}

/**
 * Install NOTIFY trigger functions and triggers on runs and run_logs tables.
 * Safe to call multiple times (uses CREATE OR REPLACE).
 */
export async function createNotifyTriggers(db: Db): Promise<void> {
  // Trigger function for run changes
  await db.execute(drizzleSql`
    CREATE OR REPLACE FUNCTION notify_run_change()
    RETURNS TRIGGER AS $$
    BEGIN
      PERFORM pg_notify('run_update', json_build_object(
        'operation', TG_OP,
        'id', NEW.id,
        'package_id', NEW.package_id,
        'status', NEW.status,
        'user_id', NEW.user_id,
        'end_user_id', NEW.end_user_id,
        'org_id', NEW.org_id,
        'application_id', NEW.application_id,
        'schedule_id', NEW.schedule_id,
        -- Bound the error text: the whole NOTIFY payload must stay under
        -- Postgres' 8 KB limit, else pg_notify raises and aborts the
        -- finalize transaction — orphaning the run in 'running'. 2 KB is
        -- ample for a surfaced error message; the full text lives in run_logs.
        'error', LEFT(NEW.error, 2000),
        'started_at', to_char(NEW.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'completed_at', to_char(NEW.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'duration', NEW.duration
      )::text);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  // Trigger function for run log inserts
  await db.execute(drizzleSql`
    CREATE OR REPLACE FUNCTION notify_run_log_insert()
    RETURNS TRIGGER AS $$
    DECLARE
      _application_id text;
    BEGIN
      SELECT application_id INTO _application_id FROM runs WHERE id = NEW.run_id;
      PERFORM pg_notify('run_log_insert', json_build_object(
        'id', NEW.id,
        'run_id', NEW.run_id,
        'org_id', NEW.org_id,
        'application_id', _application_id,
        'type', NEW.type,
        'level', NEW.level,
        'event', NEW.event,
        'message', LEFT(NEW.message, 2000),
        'data', CASE
          WHEN NEW.data IS NULL THEN NULL
          WHEN octet_length(NEW.data::text) <= 6000 THEN NEW.data
          ELSE '"[payload too large]"'::jsonb
        END,
        'created_at', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )::text);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  // Create triggers idempotently. Use DO blocks with explicit existence
  // checks instead of DROP TRIGGER IF EXISTS to avoid NOTICE logs on first
  // boot (when the triggers don't exist yet).
  //
  // The runs trigger is SPLIT in two — INSERT (unconditional) and UPDATE
  // (guarded by a WHEN clause) — because a trigger declared for INSERT cannot
  // reference OLD in its WHEN condition; Postgres rejects such a combined
  // trigger at CREATE time.
  //
  // Why the UPDATE guard exists: the run-event ingestion CAS
  // (`persistEventAndAdvance`) UPDATEs `runs` once PER INGESTED EVENT, setting
  // only `last_event_sequence` + `last_heartbeat_at`. Neither appears in the
  // NOTIFY payload, so every one of those writes broadcast a payload BYTE-FOR-
  // BYTE identical to the previous one, to every SSE subscriber in the org.
  // The 30 s runner heartbeat has the same shape.
  //
  // The WHEN condition below lists EXACTLY the columns `notify_run_change`
  // interpolates into the payload, compared with `IS DISTINCT FROM` so a
  // NULL↔value transition counts as a change. An UPDATE is therefore
  // suppressed only when the notification it would emit is identical to the
  // one the previous write already delivered — the fan-out is unchanged for
  // every payload-visible transition (status, error, timestamps, duration,
  // ownership, scheduling). `error` is compared in full even though the
  // payload truncates it to 2 000 chars: comparing the untruncated value can
  // only make the guard fire MORE often, never less.
  //
  // Columns deliberately NOT in the list (a write touching only these no
  // longer notifies `run_update`): `last_event_sequence`, `last_heartbeat_at`,
  // `cost`, `token_usage`, `result`, `checkpoint`, `artifacts`,
  // `sink_closed_at`. None of them is readable from a `run_update` frame —
  // live cost/usage reach the UI on the dedicated `run_metric` channel, and
  // the terminal values ride the finalize UPDATE, which also writes `status`
  // + `completed_at` and therefore still fires.
  await db.execute(drizzleSql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'runs_notify_trigger') THEN
        DROP TRIGGER runs_notify_trigger ON runs;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'runs_notify_insert_trigger') THEN
        DROP TRIGGER runs_notify_insert_trigger ON runs;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'runs_notify_update_trigger') THEN
        DROP TRIGGER runs_notify_update_trigger ON runs;
      END IF;
      CREATE TRIGGER runs_notify_insert_trigger
        AFTER INSERT ON runs
        FOR EACH ROW EXECUTE FUNCTION notify_run_change();
      CREATE TRIGGER runs_notify_update_trigger
        AFTER UPDATE ON runs
        FOR EACH ROW
        WHEN (
          OLD.id IS DISTINCT FROM NEW.id
          OR OLD.package_id IS DISTINCT FROM NEW.package_id
          OR OLD.status IS DISTINCT FROM NEW.status
          OR OLD.user_id IS DISTINCT FROM NEW.user_id
          OR OLD.end_user_id IS DISTINCT FROM NEW.end_user_id
          OR OLD.org_id IS DISTINCT FROM NEW.org_id
          OR OLD.application_id IS DISTINCT FROM NEW.application_id
          OR OLD.schedule_id IS DISTINCT FROM NEW.schedule_id
          OR OLD.error IS DISTINCT FROM NEW.error
          OR OLD.started_at IS DISTINCT FROM NEW.started_at
          OR OLD.completed_at IS DISTINCT FROM NEW.completed_at
          OR OLD.duration IS DISTINCT FROM NEW.duration
        )
        EXECUTE FUNCTION notify_run_change();
    END $$;
  `);

  await db.execute(drizzleSql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'run_logs_notify_trigger') THEN
        DROP TRIGGER run_logs_notify_trigger ON run_logs;
      END IF;
      CREATE TRIGGER run_logs_notify_trigger
        AFTER INSERT ON run_logs
        FOR EACH ROW EXECUTE FUNCTION notify_run_log_insert();
    END $$;
  `);

  // ────────────────────────────────────────────────────────────────────
  // integration_connections — drives live updates of the "Reconnection
  // required" badge across every consumer (connectors page, agent picker,
  // integration detail, status cards). Without this, the badge only
  // refreshes on window-focus refetch and stays stale across tabs.
  //
  // Tenant scope: the payload carries `application_id` only — the table
  // has no `org_id` column (org is enforced via the `applications` row).
  // The realtime subscriber filter relies on the SSE auth gate
  // (`validateSSEAuth`) having proven `applicationId ∈ orgId`, so this
  // payload-side scope is sufficient.
  //
  // DELETE branch carries the OLD row's identifiers so the frontend can
  // invalidate the right cache; `needs_reconnection` is NULL on delete
  // and the listener only uses the integration id + actor.
  // ────────────────────────────────────────────────────────────────────
  await db.execute(drizzleSql`
    CREATE OR REPLACE FUNCTION notify_integration_connection_change()
    RETURNS TRIGGER AS $$
    BEGIN
      -- NEW is null on DELETE, OLD is null on INSERT — branch instead of
      -- COALESCE'ing whole row records (Postgres can't compare composite
      -- types to null via COALESCE in plpgsql reliably).
      IF (TG_OP = 'DELETE') THEN
        PERFORM pg_notify('connection_update', json_build_object(
          'operation', TG_OP,
          'id', OLD.id,
          'integration_package_id', OLD.integration_package_id,
          'auth_key', OLD.auth_key,
          'user_id', OLD.user_id,
          'end_user_id', OLD.end_user_id,
          'application_id', OLD.application_id,
          'needs_reconnection', NULL,
          'deleted', TRUE
        )::text);
        RETURN OLD;
      ELSE
        PERFORM pg_notify('connection_update', json_build_object(
          'operation', TG_OP,
          'id', NEW.id,
          'integration_package_id', NEW.integration_package_id,
          'auth_key', NEW.auth_key,
          'user_id', NEW.user_id,
          'end_user_id', NEW.end_user_id,
          'application_id', NEW.application_id,
          'needs_reconnection', NEW.needs_reconnection,
          'deleted', FALSE
        )::text);
        RETURN NEW;
      END IF;
    END;
    $$ LANGUAGE plpgsql
  `);

  await db.execute(drizzleSql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'integration_connections_notify_trigger') THEN
        DROP TRIGGER integration_connections_notify_trigger ON integration_connections;
      END IF;
      CREATE TRIGGER integration_connections_notify_trigger
        AFTER INSERT OR UPDATE OR DELETE ON integration_connections
        FOR EACH ROW EXECUTE FUNCTION notify_integration_connection_change();
    END $$;
  `);
}
