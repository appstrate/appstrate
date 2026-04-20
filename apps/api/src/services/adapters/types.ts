// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { modelCostSchema } from "@appstrate/shared-types";
import type { ModelCost } from "@appstrate/shared-types";
import type { ResourceEntry as ToolMeta } from "@appstrate/shared-types";
import type { JSONSchemaObject } from "@appstrate/core/form";

export type { ModelCost };
export { modelCostSchema };

export const tokenUsageSchema = z.object({
  input_tokens: z.number().nonnegative(),
  output_tokens: z.number().nonnegative(),
  cache_creation_input_tokens: z.number().nonnegative().optional(),
  cache_read_input_tokens: z.number().nonnegative().optional(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

export interface RunMessage {
  type: "progress" | "usage" | "error" | "output" | "set_state" | "add_memory" | "report";
  message?: string;
  data?: Record<string, unknown>;
  usage?: TokenUsage;
  cost?: number;
  level?: "debug" | "info" | "warn" | "error";
  content?: string;
}

export interface UploadedFile {
  fieldName: string;
  name: string;
  type: string;
  size: number;
  buffer: Buffer;
}

export type FileReference = Omit<UploadedFile, "buffer">;

export type { ToolMeta };

export interface PromptContext {
  /**
   * AFPS schemaVersion from the agent manifest (e.g. `"1.0"`, `"1.1"`).
   * Selects the render path in `buildEnrichedPrompt`:
   *   - `"1.0"` (or absent / unrecognised) → rawPrompt appended verbatim.
   *   - `"1.1"` and above → rawPrompt rendered via logic-less Mustache
   *     against a {@link PromptView} (see @appstrate/afps-runtime/bundle).
   */
  schemaVersion?: string;
  /** Unique run identifier, exposed to 1.1+ templates as `{{runId}}`. */
  runId?: string;
  rawPrompt: string;
  tokens: Record<string, string>;
  config: Record<string, unknown>;
  previousState: Record<string, unknown> | null;
  runApi?: { url: string; token: string };
  input: Record<string, unknown>;
  files?: FileReference[];
  schemas: {
    input?: JSONSchemaObject;
    config?: JSONSchemaObject;
    output?: JSONSchemaObject;
  };
  providers: Array<{
    id: string;
    displayName: string;
    authMode: string;
    credentialSchema?: Record<string, unknown>;
    credentialFieldName?: string;
    credentialHeaderName?: string;
    credentialHeaderPrefix?: string;
    authorizedUris?: string[];
    allowAllUris?: boolean;
    docsUrl?: string;
    hasProviderDoc?: boolean;
    categories?: string[];
  }>;
  memories?: Array<{ id: number; content: string; createdAt: string | null }>;
  llmModel: string;
  llmConfig: {
    api: string;
    baseUrl: string;
    modelId: string;
    apiKey: string;
    input?: string[] | null;
    contextWindow?: number | null;
    maxTokens?: number | null;
    reasoning?: boolean | null;
    cost?: ModelCost | null;
  };
  proxyUrl?: string | null;
  timeout?: number;
  availableTools?: ToolMeta[];
  availableSkills?: ToolMeta[];
  toolDocs?: Array<{ id: string; content: string }>;
}

export interface RunAdapter {
  execute(
    runId: string,
    ctx: PromptContext,
    timeout: number,
    agentPackage?: Buffer,
    signal?: AbortSignal,
    inputFiles?: UploadedFile[],
  ): AsyncGenerator<RunMessage>;
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}
