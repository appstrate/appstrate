import type { PromptContext } from "./adapters/types.ts";
import type { LoadedFlow } from "../types/index.ts";
import type { FileReference } from "./adapters/types.ts";

/**
 * Build the execution API descriptor for container-to-host calls.
 */
export function buildExecutionApi(executionId: string): { url: string; token: string } {
  const url =
    process.env.PLATFORM_API_URL || `http://host.docker.internal:${process.env.PORT || "3000"}`;
  return { url, token: executionId };
}

/**
 * Builds a structured PromptContext from flow data.
 */
export function buildPromptContext(params: {
  flow: LoadedFlow;
  tokens: Record<string, string>;
  config: Record<string, unknown>;
  previousState: Record<string, unknown> | null;
  executionApi?: { url: string; token: string };
  input?: Record<string, unknown>;
  files?: FileReference[];
}): PromptContext {
  return {
    rawPrompt: params.flow.prompt,
    tokens: params.tokens,
    config: params.config,
    previousState: params.previousState,
    executionApi: params.executionApi,
    input: params.input ?? {},
    files: params.files,
    schemas: {
      input: params.flow.manifest.input?.schema,
      config: params.flow.manifest.config?.schema,
      output: params.flow.manifest.output?.schema,
    },
    services: params.flow.manifest.requires.services.map((s) => ({
      id: s.id,
      provider: s.provider,
      description: s.description,
    })),
    llmModel: process.env.LLM_MODEL || "claude-sonnet-4-5-20250929",
  };
}
