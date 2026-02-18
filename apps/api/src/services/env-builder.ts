import type { PromptContext } from "./adapters/types.ts";
import type { LoadedFlow } from "../types/index.ts";
import type { FileReference } from "./adapters/types.ts";

/**
 * Builds a structured PromptContext from flow data.
 * Replaces the old buildContainerEnv() that flattened everything into env vars.
 */
export function buildPromptContext(params: {
  flow: LoadedFlow;
  tokens: Record<string, string>;
  config: Record<string, unknown>;
  state: Record<string, unknown>;
  input?: Record<string, unknown>;
  files?: FileReference[];
}): PromptContext {
  return {
    rawPrompt: params.flow.prompt,
    tokens: params.tokens,
    config: params.config,
    state: params.state,
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
