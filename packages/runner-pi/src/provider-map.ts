// SPDX-License-Identifier: Apache-2.0

/**
 * The Pi `MODEL_API` shape → Pi SDK {@link AuthStorage} provider-key map.
 *
 * Kept in its own module — with NO Pi SDK import — so the boot-critical
 * consumers (`runtime-pi/entrypoint.ts` builds `model.provider` here; the
 * `appstrate` CLI resolves the same key) can pull it WITHOUT dragging
 * `pi-runner.ts` and, through it, the heavy `@mariozechner/pi-coding-agent`
 * module. `pi-runner.ts` and the package barrel re-export from here so every
 * existing import path (`@appstrate/runner-pi`) keeps working.
 */

import type { ModelApiShape } from "@appstrate/core/sidecar-types";

/**
 * Single source of truth for both the in-container path (entrypoint builds
 * `model.provider` from it) and the CLI's local-run resolver, which imports
 * this const + {@link deriveProviderFromApi} rather than keeping its own copy.
 */
export const PROVIDER_BY_API: Record<ModelApiShape, string> = {
  "anthropic-messages": "anthropic",
  "openai-completions": "openai",
  "openai-responses": "openai",
  "openai-codex-responses": "openai",
  "mistral-conversations": "mistral",
  "google-generative-ai": "google",
  "google-vertex": "google-vertex",
  "azure-openai-responses": "azure-openai-responses",
  "bedrock-converse-stream": "amazon-bedrock",
};

/**
 * Convert a Pi `MODEL_API` string into the provider key the Pi SDK's
 * {@link AuthStorage} uses to look up API keys.
 */
export function deriveProviderFromApi(api: string): string {
  const provider = (PROVIDER_BY_API as Record<string, string>)[api];
  if (!provider) throw new Error(`PiRunner: unknown model api "${api}"`);
  return provider;
}
