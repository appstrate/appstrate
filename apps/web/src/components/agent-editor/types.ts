// SPDX-License-Identifier: Apache-2.0

export type { ResourceEntry } from "@appstrate/shared-types";
export type { ManifestProviderEntry as ProviderEntry } from "@appstrate/core/dependencies";

export interface AgentEditorState {
  manifest: Record<string, unknown>;
  prompt: string;
  lockVersion?: number;
}
