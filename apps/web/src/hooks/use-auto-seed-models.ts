// SPDX-License-Identifier: Apache-2.0

/**
 * Onboarding-only helper that seeds `org_models` rows right after a fresh
 * OAuth pairing succeeds. Wired into the onboarding quick-connect cards —
 * NOT into the generic credential form modal flow, because users launching
 * OAuth from the model picker explicitly want a single model.
 *
 * Delegates to the platform's `POST /api/models/seed` endpoint, which:
 *   1. Skips entirely if any model already binds to this credential.
 *   2. Seeds every featured model from the registry.
 *   3. Promotes the first inserted row to default if the org has none.
 *
 * One round-trip, atomic — the previous N-POST-per-model dance was
 * superseded by phase 1.3 of the optimization plan.
 */

import { useQueryClient } from "@tanstack/react-query";
import { client } from "../api/client";
import { useProvidersRegistry, type ProviderRegistryEntry } from "./use-model-provider-credentials";

interface SeedResult {
  /** Number of models created. Zero when the org already had models for this credential. */
  created: number;
  /** Whether one of the freshly-created rows was promoted to default. */
  promotedDefault: boolean;
}

export function useAutoSeedFeaturedModels() {
  const qc = useQueryClient();
  const registryQuery = useProvidersRegistry();

  const seed = async (credentialId: string, providerId: string): Promise<SeedResult> => {
    const registry: ProviderRegistryEntry[] | undefined = registryQuery.data;
    const entry = registry?.find((p) => p.providerId === providerId);
    if (!entry) return { created: 0, promotedDefault: false };

    // Auto-seed = featured only (never the full catalog). Catalog-covered
    // providers expose every catalog model via the registry, but we only
    // seed the curated subset on first connection.
    const toSeed = entry.models.filter((m) => m.featured);
    if (toSeed.length === 0) return { created: 0, promotedDefault: false };

    try {
      const { data } = await client.POST("/api/models/seed", {
        body: {
          credentialId,
          modelIds: toSeed.map((m) => m.id),
        },
      });
      // Non-2xx throws via the client middleware, so `data` is defined here.
      if (!data) return { created: 0, promotedDefault: false };
      qc.invalidateQueries({ queryKey: ["get", "/api/models"] });
      return { created: data.created, promotedDefault: data.promotedDefault };
    } catch {
      // Seed is best-effort — onboarding can still continue if seeding fails.
      return { created: 0, promotedDefault: false };
    }
  };

  return { seed, registryReady: !registryQuery.isLoading && !!registryQuery.data };
}
