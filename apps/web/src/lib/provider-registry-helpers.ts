// SPDX-License-Identifier: Apache-2.0

/**
 * Registry-driven provider/model lookup helpers. Every lookup is a function
 * over `ProviderRegistryEntry[]` (what `useProvidersRegistry()` resolves to);
 * no provider constant lives in the client.
 */

import type { ProviderRegistryEntry } from "../hooks/use-model-provider-credentials";

/**
 * Picker value of the single "custom endpoint" row every `baseUrlOverridable`
 * entry collapses into. Picker-only: the form always holds a real `providerId`.
 */
export const CUSTOM_ENDPOINT_ID = "__custom_endpoint__";

type ProviderPickerRow<T> =
  { kind: "provider"; featured: boolean; entry: T } | { kind: "customEndpoint"; featured: false };

/** Pinned-endpoint entries, then one custom-endpoint row (in the "other" group) if any qualifies. */
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

/** The `providerId` a picker value stands for: the custom row opens on the first overridable entry. */
export function pickedProviderId<T extends { providerId: string; baseUrlOverridable: boolean }>(
  picked: string,
  entries: readonly T[],
): string {
  if (picked !== CUSTOM_ENDPOINT_ID) return picked;
  return entries.find((e) => e.baseUrlOverridable)?.providerId ?? "";
}

/** Match on `apiShape` and `baseUrl` prefix; trailing slashes are ignored. */
function findProviderByApiShapeAndBaseUrl(
  apiShape: string | null,
  baseUrl: string | null | undefined,
  registry: readonly ProviderRegistryEntry[],
): ProviderRegistryEntry | undefined {
  if (!apiShape || !baseUrl) return undefined;
  const normalized = baseUrl.replace(/\/+$/, "");
  return registry.find(
    (p) => p.apiShape === apiShape && normalized.startsWith(p.defaultBaseUrl.replace(/\/+$/, "")),
  );
}

export function getProviderById(
  id: string,
  registry: readonly ProviderRegistryEntry[],
): ProviderRegistryEntry | undefined {
  return registry.find((p) => p.providerId === id);
}

/**
 * The registry entry behind a saved row. `providerId` answers for any endpoint,
 * a custom URL included; the `(apiShape, baseUrl)` match is the fallback for
 * rows whose binding is hidden (built-in credentials, aliased models).
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
 * The `providerId` owning a `(apiShape, baseUrl, modelId?)` row: the catalog
 * owner of `modelId` first, then the base-URL match. `""` when none claims it.
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
