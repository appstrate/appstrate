// SPDX-License-Identifier: Apache-2.0

import { sql as drizzleSql } from "drizzle-orm";
import type { Db } from "./client.ts";

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
        'org_id', NEW.org_id,
        'application_id', NEW.application_id,
        'schedule_id', NEW.schedule_id,
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
        'created_at', NEW.created_at
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
}
