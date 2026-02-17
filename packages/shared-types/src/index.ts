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

// --- JSON Schema Types ---

export interface JSONSchemaProperty {
  type: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  format?: string;
  placeholder?: string; // custom extension
}

export interface JSONSchemaObject {
  type: "object";
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
}

export interface ServiceStatus {
  id: string;
  provider: string;
  description: string;
  status: "connected" | "not_connected";
  authMode?: string;
  connectUrl?: string;
  connectionMode?: "user" | "admin";
  adminProvided?: boolean;
  adminUserId?: string;
  adminDisplayName?: string;
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
  tags: string[];
  source: "built-in" | "user";
  requires: {
    services: ServiceStatus[];
    skills: { id: string; name?: string; description?: string }[];
    extensions: { id: string; name?: string; description?: string }[];
  };
  input?: {
    schema: JSONSchemaObject;
  };
  output?: {
    schema: JSONSchemaObject;
  };
  config: {
    schema: JSONSchemaObject;
    current: Record<string, unknown>;
  };
  state: Record<string, unknown>;
  runningExecutions: number;
  lastExecution: Partial<Execution> | null;
  updatedAt?: string | null;
  prompt?: string;
  stateSchema?: { schema: JSONSchemaObject } | null;
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
