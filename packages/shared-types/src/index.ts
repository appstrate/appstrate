export type { Database, Tables, TablesInsert, TablesUpdate, Json } from "./database.ts";
import type { Tables } from "./database.ts";

// --- Execution Types (derived from DB) ---

export type ExecutionStatus = "pending" | "running" | "success" | "failed" | "timeout";

export type Execution = Tables<"executions">;
export type ExecutionLog = Tables<"execution_logs">;

// --- Flow DB Row Type ---

export type FlowRow = Tables<"flows">;

// --- Schedule Types (derived from DB) ---

export type Schedule = Tables<"flow_schedules">;

// --- Profile Types (derived from DB) ---

export type Profile = Tables<"profiles">;

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
  authMode?: string;
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
  source: "built-in" | "user";
}

export interface FlowDetail {
  id: string;
  displayName: string;
  description: string;
  version: string;
  author: string;
  source: "built-in" | "user";
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
  runningExecutions: number;
  lastExecution: Partial<Execution> | null;
  updatedAt?: string | null;
  prompt?: string;
  rawSkills?: { id: string; description: string; content: string }[];
  stateSchema?: { schema: Record<string, { type: string; format?: string }> } | null;
  executionSettings?: { timeout?: number; maxTokens?: number; outputRetries?: number } | null;
}

// --- Integration Types ---

export interface Integration {
  uniqueKey: string;
  provider: string;
  displayName: string;
  logo?: string;
  status: "connected" | "not_connected";
  authMode?: string;
  connectedAt?: string;
}
