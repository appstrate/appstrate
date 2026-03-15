import type { SchemaField } from "./schema-section";
import type { ExecutionSettings } from "./execution-section";

export type EditorTab = "general" | "prompt" | "providers" | "schema" | "skills" | "tools" | "json";

export interface ProviderEntry {
  id: string;
  version: string;
  scopes: string[];
  connectionMode: "user" | "admin";
}

export interface ResourceEntry {
  id: string;
  version: string;
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
    keywords: string[];
  };
  prompt: string;
  providers: ProviderEntry[];
  skills: ResourceEntry[];
  tools: ResourceEntry[];
  inputSchema: SchemaField[];
  outputSchema: SchemaField[];
  configSchema: SchemaField[];
  execution: ExecutionSettings;
  _manifestBase: Record<string, unknown>;
}
