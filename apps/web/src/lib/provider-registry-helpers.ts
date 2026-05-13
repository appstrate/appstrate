// SPDX-License-Identifier: Apache-2.0

/**
 * Registry-driven replacements for the legacy `model-presets.ts` helpers.
 *
 * Every lookup is a function over `ProviderRegistryEntry[]` (what the
 * `useProvidersRegistry()` hook resolves to). No constants live in the
 * client anymore — adding a provider is a server-side edit to the
 * `core-providers` module (or any other module that contributes via
 * `modelProviders()`).
 */

import type { ProviderRegistryEntry } from "../hooks/use-model-provider-credentials";

/** Sentinel used by the form modals to mean "I want to fill in custom fields myself". */
export const CUSTOM_ID = "__custom__";

/**
 * Supported Pi SDK adapter shapes (in-container LLM client). Mirrors
 * `ModelApiShape` in core but stays here for the UI's "custom provider"
 * picker — the operator chooses one of these when their endpoint isn't
 * in the registry. The list is curated against what `@mariozechner/pi-ai`
 * actually exposes.
 */
export const PI_ADAPTER_TYPES = [
  { value: "openai-completions", label: "OpenAI / Compatible" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "mistral-conversations", label: "Mistral" },
  { value: "anthropic-messages", label: "Anthropic" },
  { value: "google-generative-ai", label: "Google AI" },
  { value: "google-vertex", label: "Google Vertex AI" },
  { value: "azure-openai-responses", label: "Azure OpenAI" },
  { value: "bedrock-converse-stream", label: "AWS Bedrock" },
] as const;

/**
 * Locate the provider that owns a given `(apiShape, baseUrl)` combination.
 * Used by run-overrides, agent-configuration, and the credential form's
 * "what icon should this row show?" lookup. Matches on apiShape AND
 * baseUrl prefix — `baseUrl` is normalized (trailing slashes stripped)
 * because the DB column may or may not carry a trailing `/` depending on
 * how the credential was created.
 */
export function findProviderByApiShapeAndBaseUrl(
  apiShape: string,
  baseUrl: string | undefined,
  registry: readonly ProviderRegistryEntry[],
): ProviderRegistryEntry | undefined {
  if (!baseUrl) return undefined;
  const normalized = baseUrl.replace(/\/+$/, "");
  return registry.find(
    (p) => p.apiShape === apiShape && normalized.startsWith(p.defaultBaseUrl.replace(/\/+$/, "")),
  );
}

/** Lookup by `providerId`. Returns undefined for unknown ids (custom rows). */
export function getProviderById(
  id: string,
  registry: readonly ProviderRegistryEntry[],
): ProviderRegistryEntry | undefined {
  return registry.find((p) => p.providerId === id);
}

/**
 * Match a model by apiShape + modelId across the entire registry. Returns
 * both the owning provider and the matching model entry — callers use
 * this to seed the model-form fields (label, context window, …) from the
 * curated catalog.
 */
export function findRegistryModel(
  apiShape: string,
  modelId: string,
  registry: readonly ProviderRegistryEntry[],
): { provider: ProviderRegistryEntry; model: ProviderRegistryEntry["models"][number] } | null {
  for (const provider of registry) {
    if (provider.apiShape !== apiShape) continue;
    const model = provider.models.find((m) => m.id === modelId);
    if (model) return { provider, model };
  }
  return null;
}

/**
 * Resolve the `providerId` that owns a `(apiShape, baseUrl, modelId?)` row.
 * Tries the curated model catalog first when a `modelId` is supplied
 * (`org_models` rows), then falls back to the base-URL match
 * (`model_provider_credentials` rows have no `modelId`). Returns
 * {@link CUSTOM_ID} when no registry entry claims the row — what the form
 * modals surface as the "Custom" picker entry.
 */
export function resolveProviderId(
  spec: { apiShape: string; baseUrl: string | undefined; modelId?: string | undefined },
  registry: readonly ProviderRegistryEntry[],
): string {
  if (spec.modelId) {
    const match = findRegistryModel(spec.apiShape, spec.modelId, registry);
    if (match) return match.provider.providerId;
  }
  const byApiAndUrl = findProviderByApiShapeAndBaseUrl(spec.apiShape, spec.baseUrl, registry);
  return byApiAndUrl ? byApiAndUrl.providerId : CUSTOM_ID;
}
