// SPDX-License-Identifier: Apache-2.0

import type { EditorStateBase } from "../../hooks/use-editor-state";

export type { ResourceEntry } from "@appstrate/shared-types";
export type { ManifestProviderEntry as ProviderEntry } from "@appstrate/core/dependencies";

export interface AgentEditorState extends EditorStateBase {
  prompt: string;
}
