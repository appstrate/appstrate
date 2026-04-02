-- Migration: Rename flow → agent and execution → run
-- This is a breaking change aligned with the "Agent as a Service" positioning.

-- 1. Enum value renames
ALTER TYPE package_type RENAME VALUE 'flow' TO 'agent';
ALTER TYPE execution_status RENAME TO run_status;

-- 2. Table renames
ALTER TABLE executions RENAME TO runs;
ALTER TABLE execution_logs RENAME TO run_logs;
ALTER TABLE user_flow_provider_profiles RENAME TO user_agent_provider_profiles;

-- 3. Column renames
ALTER TABLE run_logs RENAME COLUMN execution_id TO run_id;
ALTER TABLE runs RENAME COLUMN execution_number TO run_number;
ALTER TABLE package_memories RENAME COLUMN execution_id TO run_id;

-- 4. Index renames
ALTER INDEX idx_executions_package_id RENAME TO idx_runs_package_id;
ALTER INDEX idx_executions_status RENAME TO idx_runs_status;
ALTER INDEX idx_executions_user_id RENAME TO idx_runs_user_id;
ALTER INDEX idx_executions_end_user_id RENAME TO idx_runs_end_user_id;
ALTER INDEX idx_executions_application_id RENAME TO idx_runs_application_id;
ALTER INDEX idx_executions_org_id RENAME TO idx_runs_org_id;
ALTER INDEX idx_executions_notification RENAME TO idx_runs_notification;
ALTER INDEX idx_execution_logs_execution_id RENAME TO idx_run_logs_run_id;
ALTER INDEX idx_execution_logs_lookup RENAME TO idx_run_logs_lookup;
ALTER INDEX idx_execution_logs_org_id RENAME TO idx_run_logs_org_id;

-- 5. Constraint renames
ALTER TABLE runs RENAME CONSTRAINT executions_at_most_one_actor TO runs_at_most_one_actor;

-- 6. Sequence rename (serial column)
ALTER SEQUENCE execution_logs_id_seq RENAME TO run_logs_id_seq;

-- 7. Update pg_notify triggers/functions if they reference old names
-- (Drizzle pg_notify is application-level, not DB triggers — no action needed)
