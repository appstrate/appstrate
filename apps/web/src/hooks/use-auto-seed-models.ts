// SPDX-License-Identifier: Apache-2.0

/**
 * Onboarding-only: seeds `org_models` rows right after an organization subscription is paired —
 * NOT for the generic credential modal, where users launching OAuth from the model picker want a
 * single model. `POST /api/models/seed` skips if a model already binds to the credential and
 * promotes the first row to default if the org has none.
 */

import { useQueryClient } from "@tanstack/react-query";
import { client } from "../api/client";
import { invalidatePaths } from "../lib/query-keys";
import { toastError } from "../lib/mutation-error";
import { useProvidersRegistry, type ProviderRegistryEntry } from "./use-model-provider-credentials";

interface SeedResult {
  /** Zero when the org already had models for this credential. */
  created: number;
  promotedDefault: boolean;
}

export function useAutoSeedFeaturedModels() {
  const qc = useQueryClient();
  const registryQuery = useProvidersRegistry();

  const seed = async (credentialId: string, providerId: string): Promise<SeedResult> => {
    const registry: ProviderRegistryEntry[] | undefined = registryQuery.data;
    const entry = registry?.find((p) => p.providerId === providerId);
    if (!entry) return { created: 0, promotedDefault: false };

    // Featured only, never the full catalog.
    const toSeed = entry.models.filter((m) => m.featured);
    if (toSeed.length === 0) return { created: 0, promotedDefault: false };

    try {
      const { data } = await client.POST("/api/models/seed", {
        body: {
          credentialId,
          model_ids: toSeed.map((m) => m.id),
        },
      });
      if (!data) return { created: 0, promotedDefault: false };
      void invalidatePaths(qc, ["/api/models"]);
      return { created: data.created, promotedDefault: data.promoted_default };
    } catch (err) {
      // The subscription is connected either way; models can still be added by hand.
      toastError(err);
      return { created: 0, promotedDefault: false };
    }
  };

  return { seed, registryReady: !registryQuery.isLoading && !!registryQuery.data };
}
