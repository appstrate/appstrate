-- ============================================================
-- Admin-provided service connections
-- Allows admins to bind their own service tokens for a flow,
-- so all users execute with the admin's credentials.
-- ============================================================

CREATE TABLE public.flow_admin_connections (
  flow_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  admin_user_id UUID NOT NULL REFERENCES auth.users(id),
  connected_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (flow_id, service_id)
);

CREATE INDEX idx_flow_admin_connections_flow_id ON public.flow_admin_connections(flow_id);

ALTER TABLE public.flow_admin_connections ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read (need to know if admin has bound a service)
CREATE POLICY "flow_admin_connections_select" ON public.flow_admin_connections
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- Only admins can insert/update/delete
CREATE POLICY "flow_admin_connections_insert" ON public.flow_admin_connections
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );
CREATE POLICY "flow_admin_connections_update" ON public.flow_admin_connections
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );
CREATE POLICY "flow_admin_connections_delete" ON public.flow_admin_connections
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );
