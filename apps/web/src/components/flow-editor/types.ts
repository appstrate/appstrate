export type { ResourceEntry } from "@appstrate/shared-types";

export type EditorTab = "general" | "prompt" | "providers" | "schema" | "skills" | "tools" | "json";

export interface ProviderEntry {
  id: string;
  version: string;
  scopes: string[];
  connectionMode: "user" | "admin";
}

export interface FlowEditorState {
  manifest: Record<string, unknown>;
  prompt: string;
}
