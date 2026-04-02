// SPDX-License-Identifier: Apache-2.0

export type { ResourceEntry } from "@appstrate/shared-types";

export type EditorTab = "general" | "prompt" | "providers" | "schema" | "skills" | "tools" | "json";

export interface ProviderEntry {
  id: string;
  version: string;
  scopes: string[];
}

export interface FlowEditorState {
  manifest: Record<string, unknown>;
  prompt: string;
}
