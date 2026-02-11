// --- Execution Types ---

export type ExecutionStatus = "pending" | "running" | "success" | "failed" | "timeout";

export interface Execution {
  id: string;
  flow_id: string;
  status: ExecutionStatus;
  input: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
  tokens_used: number | null;
  started_at: string;
  completed_at: string | null;
  duration: number | null;
  schedule_id: string | null;
}

export interface ExecutionLog {
  id: number;
  execution_id: string;
  type: "progress" | "system" | "error" | "result";
  event: string | null;
  message: string | null;
  data: Record<string, unknown> | null;
  created_at: string;
}

// --- Flow Field Types ---

export type FlowFieldType = "string" | "number" | "boolean" | "array" | "object";

export interface FlowFieldBase {
  type: string;
  description: string;
  required?: boolean;
}

export interface FlowConfigField extends FlowFieldBase {
  default?: unknown;
  enum?: unknown[];
}

export interface FlowInputField extends FlowFieldBase {
  default?: unknown;
  placeholder?: string;
}

// Compatible with FlowInputField for flow chaining (output flow A → input flow B)
export interface FlowOutputField extends FlowFieldBase {}

export interface ServiceStatus {
  id: string;
  provider: string;
  description: string;
  status: "connected" | "not_connected";
  connectUrl?: string;
}

export interface FlowListItem {
  id: string;
  displayName: string;
  description: string;
  version: string;
  author: string;
  tags: string[];
  runningExecutions: number;
}

export interface FlowDetail {
  id: string;
  displayName: string;
  description: string;
  version: string;
  author: string;
  requires: {
    services: ServiceStatus[];
    tools: { id: string; type: string; status: string }[];
    skills: { id: string; description: string }[];
  };
  input?: {
    schema: Record<string, FlowInputField>;
  };
  output?: {
    schema: Record<string, FlowOutputField>;
  };
  config: {
    schema: Record<string, FlowConfigField>;
    current: Record<string, unknown>;
  };
  state: Record<string, unknown>;
  lastExecution: Partial<Execution> | null;
}

// --- Schedule Types ---

export interface Schedule {
  id: string;
  flow_id: string;
  name: string | null;
  enabled: boolean;
  cron_expression: string;
  timezone: string;
  input: Record<string, unknown> | null;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

// --- Integration Types ---

export interface Integration {
  uniqueKey: string;
  provider: string;
  displayName: string;
  logo?: string;
  status: "connected" | "not_connected";
  connectedAt?: string;
}
