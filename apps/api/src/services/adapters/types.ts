// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { modelCostSchema } from "@appstrate/shared-types";
import type { ModelCost } from "@appstrate/shared-types";
import type { ResourceEntry as ToolMeta } from "@appstrate/shared-types";
import type { JSONSchemaObject } from "@appstrate/core/form";
import type { Bundle, PlatformPromptProvider } from "@appstrate/afps-runtime/bundle";

export type { ModelCost };
export { modelCostSchema };

export const tokenUsageSchema = z.object({
  input_tokens: z.number().nonnegative(),
  output_tokens: z.number().nonnegative(),
  cache_creation_input_tokens: z.number().nonnegative().optional(),
  cache_read_input_tokens: z.number().nonnegative().optional(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

export interface UploadedFile {
  fieldName: string;
  name: string;
  type: string;
  size: number;
  buffer: Buffer;
}

export type FileReference = Omit<UploadedFile, "buffer">;

export type { ToolMeta };

/**
 * Provider definition projected for prompt enrichment + sidecar wiring.
 * Extends the runtime's {@link PlatformPromptProvider} (id / displayName /
 * authMode / authorizedUris / allowAllUris / docsUrl / hasProviderDoc /
 * toolName) with platform-internal credential metadata consumed by the
 * sidecar but never surfaced to the LLM prompt.
 */
export interface ProviderSummary extends PlatformPromptProvider {
  displayName: string;
  authMode: string;
  credentialSchema?: Record<string, unknown>;
  credentialFieldName?: string;
  credentialHeaderName?: string;
  credentialHeaderPrefix?: string;
  categories?: string[];
}

export interface LlmConfig {
  api: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  input?: string[] | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  reasoning?: boolean | null;
  cost?: ModelCost | null;
}

/**
 * Platform-specific run configuration — everything that does NOT fit in the
 * AFPS {@link ExecutionContext} (auth material, infrastructure wiring,
 * container inputs). Passed alongside the AFPS context to the Pi container
 * executor so the canonical {@link ExecutionContext} stays platform-agnostic.
 */
export interface AppstrateRunPlan {
  // --- Bundle-derived (needed for prompt building + validation) ---
  /**
   * Parsed multi-package bundle. Single source of truth for the prompt
   * builder — `availableTools` / `availableSkills` / `toolDocs` /
   * bundle-side providers / input / config / output schemas are all
   * derived from this by `buildPlatformPromptInputs` at prompt-build
   * time. The DB-sourced fields below mirror this shape and are kept
   * as platform-level overrides (e.g. `providers` filtered by
   * credential availability).
   */
  bundle: Bundle;
  /** Raw Mustache prompt from the bundle. */
  rawPrompt: string;
  /** Input / config / output JSON Schemas extracted from the manifest. */
  schemas: {
    input?: JSONSchemaObject;
    config?: JSONSchemaObject;
    output?: JSONSchemaObject;
  };

  // --- LLM ---
  llmConfig: LlmConfig;

  // --- Platform wiring ---
  /** Callback URL + signed token for the agent container. Optional — runners that don't expose a callback API may omit it. */
  runApi?: { url: string; token: string };
  /** Outbound HTTP proxy, if any. */
  proxyUrl?: string | null;
  /** Seconds cap on the container lifetime. */
  timeout: number;

  // --- Resolved dependencies (container side-effects) ---
  /** Credential tokens keyed by provider id — injected into sidecar. */
  tokens: Record<string, string>;
  /** Connected providers resolved for this run — used by sidecar + prompt. */
  providers: ProviderSummary[];
  /** Tool metadata from the bundle — used for prompt enrichment. */
  availableTools: ToolMeta[];
  /** Skill metadata from the bundle — used for prompt enrichment. */
  availableSkills: ToolMeta[];
  /** Additional tool documentation (e.g. from TOOL.md). */
  toolDocs: Array<{ id: string; content: string }>;

  // --- Files ---
  /** File references surfaced in the prompt ("## Documents" section). */
  files?: FileReference[];
  /** Uploaded file buffers — materialised into the container workspace. */
  inputFiles?: UploadedFile[];
  /** Packaged bundle ZIP — injected as `/workspace/agent-package.afps`. */
  agentPackage?: Buffer | null;
}
