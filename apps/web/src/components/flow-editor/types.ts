import type { SchemaField } from "./schema-section";
import type { ExecutionSettings } from "./execution-section";

export type EditorTab =
  | "general"
  | "prompt"
  | "services"
  | "schema"
  | "skills"
  | "extensions"
  | "json";

export interface ServiceEntry {
  id: string;
  provider: string;
  scopes: string[];
  connectionMode: "user" | "admin";
}

export interface ResourceEntry {
  id: string;
  name?: string;
  description?: string;
}

export interface FlowFormState {
  metadata: {
    id: string;
    scope: string;
    version: string;
    displayName: string;
    description: string;
    author: string;
    tags: string[];
  };
  prompt: string;
  services: ServiceEntry[];
  skills: ResourceEntry[];
  extensions: ResourceEntry[];
  inputSchema: SchemaField[];
  outputSchema: SchemaField[];
  configSchema: SchemaField[];
  execution: ExecutionSettings;
  _manifestBase: Record<string, unknown>;
}
