// SPDX-License-Identifier: Apache-2.0

import { modelCostSchema, tokenUsageSchema } from "@appstrate/shared-types";
import type { TokenUsage } from "@appstrate/shared-types";
import type { ResourceEntry as ToolMeta } from "@appstrate/shared-types";
import type { JSONSchemaObject } from "@appstrate/core/form";
import type { Bundle, PlatformPromptProvider } from "@appstrate/afps-runtime/bundle";
import type { ResolvedModel } from "../org-models.ts";

export type { ToolMeta, TokenUsage, ResolvedModel };
export { modelCostSchema, tokenUsageSchema };

export interface UploadedFile {
  fieldName: string;
  name: string;
  type: string;
  size: number;
  buffer: Buffer;
}

export type FileReference = Omit<UploadedFile, "buffer">;

/**
 * Provider definition projected for prompt enrichment + sidecar wiring.
 * Extends the runtime's {@link PlatformPromptProvider} (id / displayName /
 * authMode / authorizedUris / allowAllUris / docsUrl / toolName) with
 * platform-internal credential metadata consumed by the sidecar but never
 * surfaced to the LLM prompt.
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
   * builder — tools, skills, providers, input/config/output schemas, and
   * tool docs are all derived from this by `buildPlatformPromptInputs` at
   * prompt-build time.
   */
  bundle: Bundle;
  /** Raw Mustache prompt from the bundle. */
  rawPrompt: string;
  /** Output JSON Schema (used for native LLM constrained decoding). */
  outputSchema?: JSONSchemaObject;

  // --- LLM ---
  /**
   * Resolved model + credential. `label`/`isSystemModel` are consumed by
   * the caller for the run record; `accountId` is re-read by the sidecar
   * from the credential row on each request. Both are passed through here
   * verbatim — the executor only reads the inference fields.
   */
  llmConfig: ResolvedModel;

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

  // --- Files ---
  /** File references surfaced in the prompt ("## Documents" section). */
  files?: FileReference[];
  /** Uploaded file buffers — materialised into the container workspace. */
  inputFiles?: UploadedFile[];
  /** Packaged bundle ZIP — injected as `/workspace/agent-package.afps`. */
  agentPackage?: Buffer | null;
}
