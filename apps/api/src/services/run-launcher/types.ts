// SPDX-License-Identifier: Apache-2.0

import { modelCostSchema } from "@appstrate/core/module";
import { tokenUsageSchema } from "@appstrate/core/token-usage";
import type { TokenUsage } from "@appstrate/shared-types";
import type { ResourceEntry as ToolMeta } from "@appstrate/shared-types";
import type { JSONSchemaObject } from "@appstrate/core/form";
import type { Bundle } from "@appstrate/afps-runtime/bundle";
import type { ResolvedModel } from "../org-models.ts";

export type { ToolMeta, TokenUsage, ResolvedModel };
export { modelCostSchema, tokenUsageSchema };

/**
 * Reference to an input document surfaced to a run — field, filename, MIME, and
 * size. Document bytes are streamed into the run workspace during upload-consume,
 * so this carries metadata only (no content).
 */
export interface FileReference {
  fieldName: string;
  name: string;
  type: string;
  size: number;
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
   * builder — skills, integrations, input/config/output schemas, and
   * dependency doc companions are all derived from this by
   * `buildPlatformPromptInputs` at prompt-build time.
   */
  bundle: Bundle;
  /** Raw Mustache prompt from the bundle. */
  rawPrompt: string;
  /**
   * Output JSON Schema — becomes the input schema of the `output` runtime
   * tool (AJV-validated at call time, re-validated at ingestion).
   */
  outputSchema?: JSONSchemaObject;
  /**
   * Platform runtime tools the agent selected (`manifest.runtime_tools`):
   * `output` / `log` / `note` / `pin` / `report`. Forwarded to the sidecar
   * (when present) which hosts the selected ones as MCP tools; the
   * no-sidecar path reads the same selection from the bundle manifest.
   */
  runtimeTools?: string[];

  // --- LLM ---
  /**
   * Resolved model + credential. `label`/`isSystemModel` are consumed by
   * the caller for the run record; `accountId` is re-read by the sidecar
   * from the credential row on each request. Both are passed through here
   * verbatim — the executor only reads the inference fields.
   */
  llmConfig: ResolvedModel;

  // --- Platform wiring ---
  /**
   * Signed run token authorising the sidecar's `/internal/*` calls back into
   * the platform. Optional — runners that don't expose a callback API omit
   * it. The platform URL is resolved by the container orchestrator at spawn
   * time, not surfaced on this plan.
   */
  runToken?: string;
  /** Outbound HTTP proxy, if any. */
  proxyUrl?: string | null;
  /** Seconds cap on the container lifetime. */
  timeout: number;

  // --- Files ---
  /**
   * Input-document references surfaced in the prompt ("## Documents" section).
   * The document bytes themselves are streamed into the run workspace during
   * upload-consume — the plan carries only metadata, never the content.
   */
  files?: FileReference[];
  /** Packaged bundle ZIP — injected as `/workspace/agent-package.afps`. */
  agentPackage?: Buffer | null;

  // --- Integrations (Phase 1.4) ---
  /**
   * Integrations to spawn inside the sidecar. Built by
   * `resolveIntegrationSpawns` — one entry per declared, installed,
   * and connected integration the agent depends on. Empty when the
   * agent declares no integrations or none are connected.
   */
  integrations?: ReadonlyArray<import("@appstrate/core/sidecar-types").IntegrationSpawnSpec>;
}
