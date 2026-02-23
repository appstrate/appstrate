import { sql as drizzleSql } from "drizzle-orm";
import type { Db } from "./client.ts";

/**
 * Send a NOTIFY on a channel with JSON payload.
 */
export async function pgNotify(
  db: Db,
  channel: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const jsonPayload = JSON.stringify(payload);
  await db.execute(drizzleSql`SELECT pg_notify(${channel}, ${jsonPayload})`);
}

/**
 * Install NOTIFY trigger functions and triggers on executions and execution_logs tables.
 * Safe to call multiple times (uses CREATE OR REPLACE).
 */
export async function createNotifyTriggers(db: Db): Promise<void> {
  // Trigger function for execution changes
  await db.execute(drizzleSql`
    CREATE OR REPLACE FUNCTION notify_execution_change()
    RETURNS TRIGGER AS $$
    BEGIN
      PERFORM pg_notify('execution_update', json_build_object(
        'operation', TG_OP,
        'id', NEW.id,
        'flow_id', NEW.flow_id,
        'status', NEW.status,
        'user_id', NEW.user_id,
        'org_id', NEW.org_id,
        'result', CASE WHEN NEW.result IS NOT NULL THEN NEW.result ELSE 'null'::jsonb END,
        'error', NEW.error,
        'completed_at', NEW.completed_at,
        'duration', NEW.duration,
        'tokens_used', NEW.tokens_used,
        'cost_usd', NEW.cost_usd
      )::text);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  // Trigger function for execution log inserts
  await db.execute(drizzleSql`
    CREATE OR REPLACE FUNCTION notify_execution_log_insert()
    RETURNS TRIGGER AS $$
    BEGIN
      PERFORM pg_notify('execution_log_insert', json_build_object(
        'id', NEW.id,
        'execution_id', NEW.execution_id,
        'user_id', NEW.user_id,
        'org_id', NEW.org_id,
        'type', NEW.type,
        'event', NEW.event,
        'message', NEW.message,
        'data', CASE WHEN NEW.data IS NOT NULL THEN NEW.data ELSE 'null'::jsonb END,
        'created_at', NEW.created_at
      )::text);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  // Create triggers (drop first to avoid duplicates)
  await db.execute(drizzleSql`
    DROP TRIGGER IF EXISTS executions_notify_trigger ON executions
  `);
  await db.execute(drizzleSql`
    CREATE TRIGGER executions_notify_trigger
      AFTER INSERT OR UPDATE ON executions
      FOR EACH ROW EXECUTE FUNCTION notify_execution_change()
  `);

  await db.execute(drizzleSql`
    DROP TRIGGER IF EXISTS execution_logs_notify_trigger ON execution_logs
  `);
  await db.execute(drizzleSql`
    CREATE TRIGGER execution_logs_notify_trigger
      AFTER INSERT ON execution_logs
      FOR EACH ROW EXECUTE FUNCTION notify_execution_log_insert()
  `);
}
