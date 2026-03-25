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

export interface FlowEditorState {
  manifest: Record<string, unknown>;
  prompt: string;
}
