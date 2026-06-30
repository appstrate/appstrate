// SPDX-License-Identifier: Apache-2.0

import { sql as drizzleSql } from "drizzle-orm";
import type { Db } from "./client.ts";

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
 * integers + a float, well under that ceiling.
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
        'mcp_correlation_id', NEW.metadata ->> 'appstrate.mcpRunAndWaitCorrelationId',
        'error', NEW.error,
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
  await db.execute(drizzleSql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'runs_notify_trigger') THEN
        DROP TRIGGER runs_notify_trigger ON runs;
      END IF;
      CREATE TRIGGER runs_notify_trigger
        AFTER INSERT OR UPDATE ON runs
        FOR EACH ROW EXECUTE FUNCTION notify_run_change();
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
