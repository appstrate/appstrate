-- Add state column to executions (replaces flow_state table)
ALTER TABLE public.executions ADD COLUMN state JSONB;

-- Drop flow_state table and its policies
DROP POLICY IF EXISTS "flow_state_user" ON public.flow_state;
DROP POLICY IF EXISTS "flow_state_admin" ON public.flow_state;
DROP TABLE IF EXISTS public.flow_state;
