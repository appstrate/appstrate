// Re-export shared types used by both API and frontend
export type {
  ExecutionStatus,
  Execution,
  ExecutionLog,
  FlowConfigField,
  FlowInputField,
  ServiceStatus,
  FlowListItem,
  FlowDetail,
  Integration,
  Schedule,
} from "@openflows/shared-types";

// --- Flow Manifest Types (backend-only) ---

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
  schema: Record<string, import("@openflows/shared-types").FlowInputField>;
}

export interface FlowStateSpec {
  enabled: boolean;
  schema: Record<string, { type: string; format?: string }>;
}

export interface FlowConfigSpec {
  schema: Record<string, import("@openflows/shared-types").FlowConfigField>;
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

// --- Database Models (backend-only) ---

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

export interface SSEEvent {
  event: string;
  data: Record<string, unknown>;
}
