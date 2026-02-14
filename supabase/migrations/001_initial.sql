-- ============================================================
-- Appstrate: Initial schema with multi-user support
-- ============================================================

-- Profiles (extends auth.users)
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-create profile on signup; first user becomes admin
CREATE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.email),
    CASE WHEN (SELECT COUNT(*) FROM public.profiles) = 0 THEN 'admin' ELSE 'user' END
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Flow configs: global (admin-only write)
CREATE TABLE public.flow_configs (
  flow_id TEXT PRIMARY KEY,
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Flow state: per-user
CREATE TABLE public.flow_state (
  user_id UUID NOT NULL REFERENCES auth.users(id),
  flow_id TEXT NOT NULL,
  state JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, flow_id)
);

-- Executions: per-user
CREATE TABLE public.executions (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  status TEXT NOT NULL DEFAULT 'pending',
  input JSONB,
  result JSONB,
  error TEXT,
  tokens_used INTEGER,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration INTEGER,
  schedule_id TEXT
);

CREATE INDEX idx_executions_flow_id ON public.executions(flow_id);
CREATE INDEX idx_executions_status ON public.executions(status);
CREATE INDEX idx_executions_user_id ON public.executions(user_id);

-- Execution logs: filtered via FK on executions
CREATE TABLE public.execution_logs (
  id SERIAL PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES public.executions(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'progress',
  event TEXT,
  message TEXT,
  data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_execution_logs_execution_id ON public.execution_logs(execution_id);
CREATE INDEX idx_execution_logs_lookup ON public.execution_logs(execution_id, id);

-- Flow schedules: per-user
CREATE TABLE public.flow_schedules (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  name TEXT,
  enabled BOOLEAN DEFAULT true,
  cron_expression TEXT NOT NULL,
  timezone TEXT DEFAULT 'UTC',
  input JSONB,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_schedules_flow_id ON public.flow_schedules(flow_id);
CREATE INDEX idx_schedules_user_id ON public.flow_schedules(user_id);

-- User-imported flows (built-in flows are loaded from filesystem)
CREATE TABLE public.flows (
  id TEXT PRIMARY KEY,
  manifest JSONB NOT NULL,
  prompt TEXT NOT NULL,
  skills JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT flows_id_slug CHECK (id ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$')
);

-- ============================================================
-- Row Level Security
-- ============================================================

-- profiles: everyone reads, own update
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles_select" ON public.profiles FOR SELECT USING (true);
CREATE POLICY "profiles_update" ON public.profiles FOR UPDATE USING (auth.uid() = id);

-- flow_configs: all authenticated read, admin write
ALTER TABLE public.flow_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "flow_configs_select" ON public.flow_configs FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "flow_configs_insert" ON public.flow_configs FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
);
CREATE POLICY "flow_configs_update" ON public.flow_configs FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
);
CREATE POLICY "flow_configs_delete" ON public.flow_configs FOR DELETE USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
);

-- flow_state: own data + admin sees all
ALTER TABLE public.flow_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "flow_state_user" ON public.flow_state FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "flow_state_admin" ON public.flow_state FOR ALL USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
);

-- executions: own data + admin sees all
ALTER TABLE public.executions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "executions_user" ON public.executions FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "executions_admin" ON public.executions FOR ALL USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
);

-- execution_logs: via join on executions
ALTER TABLE public.execution_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "execution_logs_user" ON public.execution_logs FOR ALL USING (
  EXISTS (SELECT 1 FROM public.executions WHERE id = execution_logs.execution_id AND user_id = auth.uid())
);
CREATE POLICY "execution_logs_admin" ON public.execution_logs FOR ALL USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
);

-- flow_schedules: own data + admin sees all
ALTER TABLE public.flow_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "flow_schedules_user" ON public.flow_schedules FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "flow_schedules_admin" ON public.flow_schedules FOR ALL USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
);

-- flows: all authenticated read, admin write
ALTER TABLE public.flows ENABLE ROW LEVEL SECURITY;
CREATE POLICY "flows_select" ON public.flows FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "flows_insert" ON public.flows FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
);
CREATE POLICY "flows_update" ON public.flows FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
);
CREATE POLICY "flows_delete" ON public.flows FOR DELETE USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
);

-- ============================================================
-- Supabase Realtime: publish execution tables
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.execution_logs, public.executions;
