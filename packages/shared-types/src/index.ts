export type { Database, Tables, TablesInsert, TablesUpdate, Json } from "./database.ts";
import type { Tables } from "./database.ts";

// --- Execution Types (derived from DB) ---

export type ExecutionStatus = "pending" | "running" | "success" | "failed" | "timeout" | "cancelled";

export type Execution = Tables<"executions">;
export type ExecutionLog = Tables<"execution_logs">;

// --- Flow DB Row Type ---

export type FlowRow = Tables<"flows">;

// --- Schedule Types (derived from DB) ---

export type Schedule = Tables<"flow_schedules">;

// --- Profile Types (derived from DB) ---

export type Profile = Tables<"profiles">;

// --- Organization Types ---

export type OrgRole = "owner" | "admin" | "member";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface OrganizationMember {
  orgId: string;
  userId: string;
  role: OrgRole;
  joinedAt: string;
  displayName?: string;
  email?: string;
}

export interface OrganizationWithRole extends Organization {
  role: OrgRole;
}

// --- JSON Schema Types ---

export interface JSONSchemaProperty {
  type: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  format?: string;
  placeholder?: string; // custom extension
  accept?: string; // file fields: allowed extensions e.g. ".pdf,.csv,.txt"
  maxSize?: number; // file fields: max size per file in bytes
  multiple?: boolean; // file fields: allow multiple files
  maxFiles?: number; // file fields: max number of files (when multiple)
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
  schema?: JSONSchemaObject;
  authorizedUris?: string[];
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
  runningExecutions: number;
  lastExecution: Partial<Execution> | null;
  updatedAt?: string | null;
  prompt?: string;
  executionSettings?: { timeout?: number; maxTokens?: number; outputRetries?: number } | null;
}

// --- Organization Library Types ---

export interface OrgSkill {
  id: string;
  name?: string | null;
  description?: string | null;
  createdBy?: string | null;
  createdByName?: string;
  createdAt: string;
  updatedAt: string;
  usedByFlows?: number;
}

export interface OrgSkillDetail extends OrgSkill {
  content: string;
  flows: { id: string; displayName: string }[];
}

export interface OrgExtension {
  id: string;
  name?: string | null;
  description?: string | null;
  createdBy?: string | null;
  createdByName?: string;
  createdAt: string;
  updatedAt: string;
  usedByFlows?: number;
}

export interface OrgExtensionDetail extends OrgExtension {
  content: string;
  flows: { id: string; displayName: string }[];
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
