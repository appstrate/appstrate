-- ============================================================
-- Add user_id to execution_logs for Supabase Realtime compatibility
-- ============================================================
-- The subquery-based RLS policy on execution_logs prevents Supabase
-- Realtime CDC from delivering INSERT events. Denormalizing user_id
-- enables a direct column-based RLS policy that works with Realtime.

-- 1. Add column (nullable first for backfill)
ALTER TABLE public.execution_logs ADD COLUMN user_id UUID REFERENCES auth.users(id);

-- 2. Backfill from executions table
UPDATE public.execution_logs SET user_id = executions.user_id
FROM public.executions WHERE execution_logs.execution_id = executions.id;

-- 3. Make NOT NULL after backfill
ALTER TABLE public.execution_logs ALTER COLUMN user_id SET NOT NULL;

-- 4. Index for RLS performance
CREATE INDEX idx_execution_logs_user_id ON public.execution_logs(user_id);

-- 5. Replace subquery-based RLS with direct column check
DROP POLICY "execution_logs_user" ON public.execution_logs;
DROP POLICY "execution_logs_admin" ON public.execution_logs;

CREATE POLICY "execution_logs_user" ON public.execution_logs
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "execution_logs_admin" ON public.execution_logs
  FOR ALL USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'));
