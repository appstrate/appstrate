// --- Flow Manifest Types ---

export interface FlowManifest {
  $schema?: string;
  version: string;
  metadata: FlowMetadata;
  requires: FlowRequirements;
  input?: FlowInputSpec;
  state?: FlowStateSpec;
  config?: FlowConfigSpec;
  execution?: FlowExecutionSpec;
}

export interface FlowMetadata {
  name: string;
  displayName: string;
  description: string;
  author: string;
  license?: string;
  tags?: string[];
}

export interface FlowRequirements {
  services: FlowServiceRequirement[];
  tools?: FlowToolRequirement[];
}

export interface FlowServiceRequirement {
  id: string;
  provider: string;
  scopes: string[];
  description: string;
}

export interface FlowToolRequirement {
  id: string;
  type: "static" | "custom";
  description: string;
}

export interface FlowInputSpec {
  schema: Record<string, FlowInputField>;
}

export interface FlowInputField {
  type: string;
  description: string;
  required?: boolean;
  default?: unknown;
  placeholder?: string;
}

export interface FlowStateSpec {
  enabled: boolean;
  schema: Record<string, { type: string; format?: string }>;
}

export interface FlowConfigSpec {
  schema: Record<string, FlowConfigField>;
}

export interface FlowConfigField {
  type: string;
  default?: unknown;
  required?: boolean;
  enum?: unknown[];
  description: string;
}

export interface FlowExecutionSpec {
  timeout?: number;
  maxTokens?: number;
}

// --- Loaded Flow (manifest + prompt + path) ---

export interface LoadedFlow {
  id: string;
  manifest: FlowManifest;
  prompt: string;
  path: string;
}

// --- Database Models ---

export interface FlowConfig {
  flow_id: string;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface FlowState {
  flow_id: string;
  state: Record<string, unknown>;
  updated_at: string;
}

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

// --- API Types ---

export interface FlowListItem {
  id: string;
  displayName: string;
  description: string;
  version: string;
  author: string;
  tags: string[];
  requires: {
    services: string[];
    tools: string[];
  };
}

export interface ServiceStatus {
  id: string;
  provider: string;
  description: string;
  status: "connected" | "not_connected";
  connectUrl?: string;
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
  };
  input?: {
    schema: Record<string, FlowInputField>;
  };
  config: {
    schema: Record<string, FlowConfigField>;
    current: Record<string, unknown>;
  };
  state: Record<string, unknown>;
  lastExecution: Partial<Execution> | null;
}

export interface SSEEvent {
  event: string;
  data: Record<string, unknown>;
}
