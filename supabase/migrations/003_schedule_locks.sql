-- Schedule run deduplication for multi-instance deployments
-- Each cron fire produces exactly one execution, even with multiple API instances.

CREATE TABLE IF NOT EXISTS public.schedule_runs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  schedule_id TEXT NOT NULL REFERENCES public.flow_schedules(id) ON DELETE CASCADE,
  fire_time TIMESTAMPTZ NOT NULL,
  execution_id TEXT REFERENCES public.executions(id) ON DELETE SET NULL,
  instance_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(schedule_id, fire_time)
);

-- Enable RLS (admin-only access, not exposed to frontend)
ALTER TABLE public.schedule_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on schedule_runs"
  ON public.schedule_runs FOR ALL
  USING (true)
  WITH CHECK (true);

-- Atomic lock acquisition: advisory lock for fast-path + unique constraint as durable guarantee.
-- Returns TRUE if this instance won the lock, FALSE if another instance already claimed it.
CREATE OR REPLACE FUNCTION public.try_acquire_schedule_lock(
  p_schedule_id TEXT,
  p_fire_time TIMESTAMPTZ,
  p_instance_id TEXT
) RETURNS BOOLEAN AS $$
DECLARE
  lock_key BIGINT;
BEGIN
  -- Compute a stable hash for advisory lock (schedule_id + fire_time)
  lock_key := abs(hashtext(p_schedule_id || '|' || p_fire_time::text));

  -- Try advisory lock (session-level, released at end of transaction)
  IF NOT pg_try_advisory_xact_lock(lock_key) THEN
    RETURN FALSE;
  END IF;

  -- Insert the lock row (unique constraint prevents duplicates)
  BEGIN
    INSERT INTO public.schedule_runs (schedule_id, fire_time, instance_id)
    VALUES (p_schedule_id, p_fire_time, p_instance_id);
    RETURN TRUE;
  EXCEPTION WHEN unique_violation THEN
    RETURN FALSE;
  END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Index for cleanup queries (find old runs)
CREATE INDEX IF NOT EXISTS idx_schedule_runs_created_at ON public.schedule_runs(created_at);
