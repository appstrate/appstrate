// SPDX-License-Identifier: Apache-2.0

/**
 * Registry-driven provider/model lookup helpers.
 *
 * Every lookup is a function over `ProviderRegistryEntry[]` (what the
 * `useProvidersRegistry()` hook resolves to). No constants live in the
 * client anymore — adding a provider is a server-side edit to the
 * `core-providers` module (or any other module that contributes via
 * `modelProviders()`).
 */

import type { ProviderRegistryEntry } from "../hooks/use-model-provider-credentials";

/**
 * Sentinel for the MODEL-level "custom" entry: a model id the picked provider's
 * catalog doesn't list, typed in by hand. It is never a `providerId` — a custom
 * endpoint is any base-URL-overridable registry entry, whose credential carries
 * the apiShape and base URL the model runs on.
 */
export const CUSTOM_ID = "__custom__";

/**
 * Sentinel for the provider picker's single "custom endpoint" row. Every
 * registry entry that lets the operator point at their own endpoint collapses
 * into it; which one is actually selected is then an "API type" choice inside
 * the endpoint arrangement. Like {@link CUSTOM_ID} it is a picker value only —
 * the form always holds, and submits, a real registry `providerId`.
 */
export const CUSTOM_ENDPOINT_ID = "__custom_endpoint__";

/** A picker row: one registry entry, or the collapsed custom-endpoint row. */
type ProviderPickerRow<T> =
  { kind: "provider"; featured: boolean; entry: T } | { kind: "customEndpoint"; featured: false };

/**
 * The rows a provider picker offers: the entries that pin their own endpoint,
 * plus — last, and only once however many entries qualify — the custom-endpoint
 * row. `featured: false` puts it in the "other" group, after everything else.
 */
export function buildProviderPickerRows<
  T extends { featured: boolean; baseUrlOverridable: boolean },
>(entries: readonly T[]): ProviderPickerRow<T>[] {
  const rows: ProviderPickerRow<T>[] = entries
    .filter((e) => !e.baseUrlOverridable)
    .map((entry) => ({ kind: "provider", featured: entry.featured, entry }));
  if (entries.some((e) => e.baseUrlOverridable)) {
    rows.push({ kind: "customEndpoint", featured: false });
  }
  return rows;
}

/**
 * Locate the provider that owns a given `(apiShape, baseUrl)` combination.
 * Used by run-overrides, agent-configuration, and the credential form's
 * "what icon should this row show?" lookup. Matches on apiShape AND
 * baseUrl prefix — `baseUrl` is normalized (trailing slashes stripped)
 * because the DB column may or may not carry a trailing `/` depending on
 * how the credential was created.
 */
export function findProviderByApiShapeAndBaseUrl(
  apiShape: string | null,
  baseUrl: string | null | undefined,
  registry: readonly ProviderRegistryEntry[],
): ProviderRegistryEntry | undefined {
  // Model aliases project `apiShape`/`baseUrl` to null (binding hidden) — no
  // provider can be resolved, and the UI shows an alias badge instead.
  if (!apiShape || !baseUrl) return undefined;
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
function findRegistryModel(
  apiShape: string | null,
  modelId: string | null,
  registry: readonly ProviderRegistryEntry[],
): { provider: ProviderRegistryEntry; model: ProviderRegistryEntry["models"][number] } | null {
  if (!apiShape || !modelId) return null;
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
 * {@link CUSTOM_ID} when no registry entry claims the row; no picker carries
 * that value, so the provider select renders unselected.
 */
export function resolveProviderId(
  spec: {
    apiShape: string | null;
    baseUrl: string | null | undefined;
    modelId?: string | null | undefined;
  },
  registry: readonly ProviderRegistryEntry[],
): string {
  if (spec.modelId) {
    const match = findRegistryModel(spec.apiShape, spec.modelId, registry);
    if (match) return match.provider.providerId;
  }
  const byApiAndUrl = findProviderByApiShapeAndBaseUrl(spec.apiShape, spec.baseUrl, registry);
  return byApiAndUrl ? byApiAndUrl.providerId : CUSTOM_ID;
}

/**
 * Resolve the model entry id that owns an `(apiShape, baseUrl, modelId)`
 * row, falling back to {@link CUSTOM_ID} when the row doesn't map to any
 * curated catalog model. Providers with no curated catalog (e.g.
 * OpenRouter, codex) keep the raw `modelId` instead of collapsing to
 * "Custom" — operators set it via the dedicated combobox / inline input.
 */
export function resolveModelEntryId(
  spec: { apiShape: string | null; baseUrl: string | null; modelId: string | null } | null,
  registry: readonly ProviderRegistryEntry[],
): string {
  if (!spec) return "";
  const match = findRegistryModel(spec.apiShape, spec.modelId, registry);
  if (match) return match.model.id;
  const byApiAndUrl = findProviderByApiShapeAndBaseUrl(spec.apiShape, spec.baseUrl, registry);
  if (byApiAndUrl) {
    if (byApiAndUrl.models.length === 0) return spec.modelId ?? CUSTOM_ID;
    return CUSTOM_ID;
  }
  return CUSTOM_ID;
}
