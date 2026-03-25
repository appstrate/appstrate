import { z } from "zod";

/** Per-model pricing in $/M tokens (margin included). */
export const modelCostSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
});
export type ModelCost = z.infer<typeof modelCostSchema>;

export const tokenUsageSchema = z.object({
  input_tokens: z.number().nonnegative(),
  output_tokens: z.number().nonnegative(),
  cache_creation_input_tokens: z.number().nonnegative().optional(),
  cache_read_input_tokens: z.number().nonnegative().optional(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

export interface ExecutionMessage {
  type: "progress" | "usage" | "error" | "output" | "set_state" | "add_memory";
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

export interface FileReference {
  fieldName: string;
  name: string;
  type: string;
  size: number;
}

export interface ToolMeta {
  id: string;
  version?: string;
  name?: string;
  description?: string;
}

export interface PromptContext {
  rawPrompt: string;
  tokens: Record<string, string>;
  config: Record<string, unknown>;
  previousState: Record<string, unknown> | null;
  executionApi?: { url: string; token: string };
  input: Record<string, unknown>;
  files?: FileReference[];
  schemas: {
    input?: import("@appstrate/shared-types").JSONSchemaObject;
    config?: import("@appstrate/shared-types").JSONSchemaObject;
    output?: import("@appstrate/shared-types").JSONSchemaObject;
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
  logsEnabled?: boolean;
}

export interface ExecutionAdapter {
  execute(
    executionId: string,
    ctx: PromptContext,
    timeout: number,
    flowPackage?: Buffer,
    signal?: AbortSignal,
    inputFiles?: UploadedFile[],
  ): AsyncGenerator<ExecutionMessage>;
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}
