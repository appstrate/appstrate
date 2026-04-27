// SPDX-License-Identifier: Apache-2.0

export type { ResourceEntry } from "@appstrate/shared-types";

export interface ProviderEntry {
  id: string;
  version: string;
  scopes: string[];
}

export interface AgentEditorState {
  manifest: Record<string, unknown>;
  prompt: string;
  lockVersion?: number;
}
