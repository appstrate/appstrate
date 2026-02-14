// Re-export shared types used by both API and frontend
export type {
  Database,
  Tables,
  TablesInsert,
  TablesUpdate,
  Json,
  ExecutionStatus,
  Execution,
  ExecutionLog,
  FlowRow,
  FlowFieldType,
  FlowFieldBase,
  FlowConfigField,
  FlowInputField,
  FlowOutputField,
  ServiceStatus,
  FlowListItem,
  FlowDetail,
  Integration,
  Schedule,
  Profile,
} from "@appstrate/shared-types";

// --- Flow Manifest Types (backend-only) ---

export interface FlowManifest {
  $schema?: string;
  version: string;
  metadata: FlowMetadata;
  requires: FlowRequirements;
  input?: FlowInputSpec;
  output?: FlowOutputSpec;
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
  schema: Record<string, import("@appstrate/shared-types").FlowInputField>;
}

export interface FlowOutputSpec {
  schema: Record<string, import("@appstrate/shared-types").FlowOutputField>;
}

export interface FlowStateSpec {
  enabled: boolean;
  schema: Record<string, { type: string; format?: string }>;
}

export interface FlowConfigSpec {
  schema: Record<string, import("@appstrate/shared-types").FlowConfigField>;
}

export interface FlowExecutionSpec {
  timeout?: number;
  maxTokens?: number;
  outputRetries?: number;
}

// --- Loaded Flow (manifest + prompt from DB) ---

export interface SkillMeta {
  id: string;
  description: string;
  content?: string;
}

export interface LoadedFlow {
  id: string;
  manifest: FlowManifest;
  prompt: string;
  skills: SkillMeta[];
  source: "built-in" | "user";
}

export interface SSEEvent {
  event: string;
  data: Record<string, unknown>;
}

// Hono context env — shared across all routers
export type AppEnv = {
  Variables: {
    user: { id: string };
    flow: LoadedFlow;
  };
};
