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
 * Sentinel for the provider picker's single "custom endpoint" row. Every
 * registry entry that lets the operator point at their own endpoint collapses
 * into it; which one is actually selected is then an "API type" choice inside
 * the endpoint arrangement. It is a picker value only — the form always holds,
 * and submits, a real registry `providerId`.
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
 * The registry `providerId` a picker value stands for. The custom-endpoint row
 * opens on the first overridable entry — the "API type" select then offers the
 * rest — and any other value is already a `providerId`.
 */
export function pickedProviderId<T extends { providerId: string; baseUrlOverridable: boolean }>(
  picked: string,
  entries: readonly T[],
): string {
  if (picked !== CUSTOM_ENDPOINT_ID) return picked;
  return entries.find((e) => e.baseUrlOverridable)?.providerId ?? "";
}

/**
 * Locate the provider that owns a given `(apiShape, baseUrl)` combination —
 * the fallback behind {@link resolveProviderEntry} and {@link resolveProviderId}
 * for rows that carry no `providerId`. Matches on apiShape AND baseUrl prefix
 * — `baseUrl` is normalized (trailing slashes stripped) because the DB column
 * may or may not carry a trailing `/` depending on how the credential was
 * created.
 */
function findProviderByApiShapeAndBaseUrl(
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
 * The registry entry behind a saved row — what its icon and display name read.
 * `providerId` is the binding itself and answers for any endpoint, an
 * operator's own included, where the `(apiShape, baseUrl)` match cannot: a
 * custom URL is by definition no registry `defaultBaseUrl`. That match stays
 * as the fallback for rows whose binding is hidden (built-in credentials,
 * aliased models), which pin a registry endpoint by construction.
 */
export function resolveProviderEntry(
  row: { providerId?: string | null; apiShape: string | null; baseUrl: string | null },
  registry: readonly ProviderRegistryEntry[],
): ProviderRegistryEntry | undefined {
  return (
    (row.providerId ? getProviderById(row.providerId, registry) : undefined) ??
    findProviderByApiShapeAndBaseUrl(row.apiShape, row.baseUrl, registry)
  );
}

/**
 * Resolve the `providerId` that owns a `(apiShape, baseUrl, modelId?)` row.
 * Tries the curated model catalog first when a `modelId` is supplied, then
 * falls back to the base-URL match (`model_provider_credentials` rows carry no
 * `modelId`). Returns `""` when no registry entry claims the row: no picker
 * carries that value, so the provider select renders unselected.
 */
export function resolveProviderId(
  spec: {
    apiShape: string | null;
    baseUrl: string | null | undefined;
    modelId?: string | null | undefined;
  },
  registry: readonly ProviderRegistryEntry[],
): string {
  if (spec.apiShape && spec.modelId) {
    const owner = registry.find(
      (p) => p.apiShape === spec.apiShape && p.models.some((m) => m.id === spec.modelId),
    );
    if (owner) return owner.providerId;
  }
  return findProviderByApiShapeAndBaseUrl(spec.apiShape, spec.baseUrl, registry)?.providerId ?? "";
}
