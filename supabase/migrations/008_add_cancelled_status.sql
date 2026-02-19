-- Add 'cancelled' to allowed execution statuses
ALTER TABLE public.executions
  DROP CONSTRAINT IF EXISTS executions_status_check,
  ADD CONSTRAINT executions_status_check
    CHECK (status IN ('pending', 'running', 'success', 'failed', 'timeout', 'cancelled'));
