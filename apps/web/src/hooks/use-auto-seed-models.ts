// SPDX-License-Identifier: Apache-2.0

/**
 * Onboarding-only: seeds `org_models` rows right after an organization subscription is paired —
 * NOT for the generic credential modal, where users launching OAuth from the model picker want a
 * single model. The subscription joined its family's configuration (the server finds or makes
 * it); `POST /api/models/seed` adds the featured models to that configuration, skips the ones it
 * already has, and promotes the first row to default if the org has none.
 */

import { useQueryClient } from "@tanstack/react-query";
import { client } from "../api/client";
import { invalidatePaths, MODEL_CACHE_PATHS } from "../lib/query-keys";
import { seedModelsBody } from "../lib/model-configs";
import { toastError } from "../lib/mutation-error";
import { useProvidersRegistry, type ProviderRegistryEntry } from "./use-model-provider-credentials";

interface SeedResult {
  /** Zero when the configuration already had the featured models. */
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
      // There is no read of one connection: its configuration comes off the list.
      const { data: list } = await client.GET("/api/model-provider-credentials", {});
      const configId = list?.data.find((c) => c.id === credentialId)?.config_id;
      if (!configId) return { created: 0, promotedDefault: false };
      const { data } = await client.POST("/api/models/seed", {
        body: seedModelsBody(
          configId,
          toSeed.map((m) => m.id),
        ),
      });
      if (!data) return { created: 0, promotedDefault: false };
      void invalidatePaths(qc, MODEL_CACHE_PATHS);
      return { created: data.created, promotedDefault: data.promoted_default };
    } catch (err) {
      // The subscription is connected either way; models can still be added by hand.
      toastError(err);
      return { created: 0, promotedDefault: false };
    }
  };

  return { seed, registryReady: !registryQuery.isLoading && !!registryQuery.data };
}
