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
  description: string;
  scopes: string;
  connectionMode: "user" | "admin";
  credentialSchema: SchemaField[];
  authorizedUris: string;
  allowAllUris: boolean;
}

export interface ResourceEntry {
  id: string;
  name?: string;
  description?: string;
}

export interface FlowFormState {
  metadata: {
    name: string;
    displayName: string;
    description: string;
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
}
