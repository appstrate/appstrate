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
  JSONSchemaProperty,
  JSONSchemaObject,
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
  skills?: SkillMeta[];
  extensions?: ExtensionMeta[];
}

export interface FlowServiceRequirement {
  id: string;
  provider: string;
  scopes: string[];
  description: string;
  connectionMode?: "user" | "admin";
}

export interface FlowInputSpec {
  schema: import("@appstrate/shared-types").JSONSchemaObject;
}

export interface FlowOutputSpec {
  schema: import("@appstrate/shared-types").JSONSchemaObject;
}

export interface FlowConfigSpec {
  schema: import("@appstrate/shared-types").JSONSchemaObject;
}

export interface FlowExecutionSpec {
  timeout?: number;
  maxTokens?: number;
  outputRetries?: number;
}

// --- Loaded Flow (manifest + prompt from DB) ---

export interface SkillMeta {
  id: string;
  name?: string;
  description?: string;
}

export interface ExtensionMeta {
  id: string;
  name?: string;
  description?: string;
}

export interface LoadedFlow {
  id: string;
  manifest: FlowManifest;
  prompt: string;
  skills: SkillMeta[];
  extensions: ExtensionMeta[];
  source: "built-in" | "user";
}

// Hono context env — shared across all routers
export type AppEnv = {
  Variables: {
    user: { id: string };
    flow: LoadedFlow;
  };
};
