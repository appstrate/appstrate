-- Schema cleanup: drop dead columns, fix RLS, add constraints, add cleanup function.

-- 1A. Drop manifest/prompt from flow_versions (data lives in Storage ZIPs)
ALTER TABLE public.flow_versions DROP COLUMN IF EXISTS manifest;
ALTER TABLE public.flow_versions DROP COLUMN IF EXISTS prompt;

-- Replace the 4-param RPC with a 2-param version
DROP FUNCTION IF EXISTS public.create_flow_version(TEXT, JSONB, TEXT, UUID);

CREATE OR REPLACE FUNCTION public.create_flow_version(
  p_flow_id TEXT,
  p_created_by UUID
) RETURNS INTEGER AS $$
DECLARE
  next_version INTEGER;
  new_id INTEGER;
BEGIN
  SELECT COALESCE(MAX(version_number), 0) + 1 INTO next_version
  FROM public.flow_versions
  WHERE flow_id = p_flow_id;

  INSERT INTO public.flow_versions (flow_id, version_number, created_by)
  VALUES (p_flow_id, next_version, p_created_by)
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 1B. Fix schedule_runs RLS: drop the overly permissive policy.
-- Service role bypasses RLS; no direct client access is needed.
DROP POLICY IF EXISTS "Service role full access on schedule_runs" ON public.schedule_runs;

-- 1C. Add CHECK constraint on executions.status
-- Safety: fix any invalid status values before adding the constraint
UPDATE public.executions
SET status = 'failed'
WHERE status NOT IN ('pending', 'running', 'success', 'failed', 'timeout');

ALTER TABLE public.executions
  ADD CONSTRAINT executions_status_check
  CHECK (status IN ('pending', 'running', 'success', 'failed', 'timeout'));

-- 1D. Cleanup function for old schedule_runs rows
CREATE OR REPLACE FUNCTION public.cleanup_old_schedule_runs(
  retention_days INTEGER DEFAULT 30
) RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.schedule_runs
  WHERE created_at < NOW() - (retention_days || ' days')::INTERVAL;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
