// SPDX-License-Identifier: Apache-2.0

/**
 * Onboarding-only helper that seeds `org_models` rows right after a fresh
 * OAuth pairing succeeds. Wired into the onboarding quick-connect cards —
 * NOT into the generic `OAuthModelProviderDialog` flow, because users
 * launching OAuth from the model picker explicitly want a single model.
 *
 * Policy:
 *   1. If the org already has ANY model for this `providerId`, do nothing —
 *      respect manual configuration (e.g. user disconnected + reconnected).
 *   2. Seed every model marked `recommended: true` in the registry. If no
 *      model carries that flag, fall back to seeding the whole list.
 *   3. If the org has no default model, the first seeded row becomes default.
 */

import { useQueryClient } from "@tanstack/react-query";
import { api, apiList } from "../api";
import { useProvidersRegistry, type ProviderRegistryEntry } from "./use-model-provider-credentials";
import type { OrgModelInfo } from "@appstrate/shared-types";

interface SeedResult {
  /** Number of models created. Zero when the org already had models for this provider. */
  created: number;
  /** Whether one of the freshly-created rows was promoted to default. */
  promotedDefault: boolean;
}

export function useAutoSeedRecommendedModels() {
  const qc = useQueryClient();
  const registryQuery = useProvidersRegistry();

  const seed = async (credentialId: string, providerId: string): Promise<SeedResult> => {
    const registry: ProviderRegistryEntry[] | undefined = registryQuery.data;
    const entry = registry?.find((p) => p.providerId === providerId);
    if (!entry) return { created: 0, promotedDefault: false };

    // Refetch the current model list — onboarding has live SSE state, so a
    // stale React Query cache could mislead the dedup check.
    const models = await apiList<OrgModelInfo>("/models");
    const hasExistingForProvider = models.some((m) => m.credentialId === credentialId);
    if (hasExistingForProvider) {
      return { created: 0, promotedDefault: false };
    }

    const recommended = entry.models.filter((m) => m.recommended);
    const toSeed = recommended.length > 0 ? recommended : entry.models;
    if (toSeed.length === 0) return { created: 0, promotedDefault: false };

    const orgHasDefault = models.some((m) => m.isDefault);

    let created = 0;
    let promotedDefault = false;
    let firstCreatedId: string | null = null;

    for (const m of toSeed) {
      try {
        const res = await api<{ id: string }>("/models", {
          method: "POST",
          body: JSON.stringify({
            label: m.id,
            apiShape: entry.apiShape,
            baseUrl: entry.defaultBaseUrl,
            modelId: m.id,
            credentialId,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens ?? undefined,
            input: m.capabilities.filter((c) => c === "text" || c === "image"),
            reasoning: m.capabilities.includes("reasoning"),
          }),
        });
        created++;
        if (!firstCreatedId) firstCreatedId = res.id;
      } catch {
        // Seed is best-effort — a duplicate-label or transient failure on one
        // model shouldn't abort the rest. The user can always fix it manually.
      }
    }

    if (!orgHasDefault && firstCreatedId) {
      try {
        await api("/models/default", {
          method: "PUT",
          body: JSON.stringify({ modelId: firstCreatedId }),
        });
        promotedDefault = true;
      } catch {
        // Non-fatal — the user can set a default manually.
      }
    }

    qc.invalidateQueries({ queryKey: ["models"] });
    return { created, promotedDefault };
  };

  return { seed, registryReady: !registryQuery.isLoading && !!registryQuery.data };
}
