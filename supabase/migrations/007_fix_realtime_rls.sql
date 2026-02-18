-- Fix Supabase Realtime CDC for execution tables.
-- Realtime cannot evaluate SECURITY DEFINER functions (is_org_member) in RLS policies.
-- Add back direct column-based policies for Realtime compatibility.
-- PostgreSQL OR's multiple SELECT policies: Realtime uses the simple one, REST uses both.

CREATE POLICY "executions_select_realtime" ON public.executions
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "execution_logs_select_realtime" ON public.execution_logs
  FOR SELECT USING (auth.uid() = user_id);
