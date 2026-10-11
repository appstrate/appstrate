// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import {
  useCreateModel,
  useDeleteModel,
  useSetDefaultModel,
  type OrgModelInfo,
} from "./use-models";
import { useCreateModelProviderCredential } from "./use-model-provider-credentials";
import { rowToEntry } from "../lib/model-form-payload";
import type { ModelChoicePlan } from "../lib/model-choice";

/** Where the models of a choice live: an organization key, or no key (each person's own). */
interface ModelChoiceTarget {
  credentialId: string | null;
  /** The service, named on a model left to personal keys. */
  providerId: string;
}

/** The key to mint first, in « Add a provider »: nothing else exists until the models are chosen. */
export interface NewProviderCredential {
  label: string;
  providerId: string;
  apiKey: string;
  baseUrlOverride?: string;
}

interface ModelChoiceOutcome {
  /** The upstream ids whose creation or deletion was refused. */
  failedModelIds: string[];
  /** The key minted, to bind a retry to instead of minting a second one. */
  credentialId: string | null;
}

/**
 * Applies a {@link ModelChoicePlan}: the key first when there is one to mint, then each model
 * created or deleted, then the default. A refusal of the key rejects (nothing was written);
 * a refusal of a model is reported in the outcome, and the rest still go through.
 */
export function useApplyModelChoice() {
  const createModel = useCreateModel();
  const deleteModel = useDeleteModel();
  const setDefault = useSetDefaultModel();
  const createCredential = useCreateModelProviderCredential({ errorHandledByCaller: true });
  const [isPending, setPending] = useState(false);

  const apply = async (input: {
    plan: ModelChoicePlan;
    existing: readonly OrgModelInfo[];
    target: ModelChoiceTarget;
    newCredential?: NewProviderCredential;
  }): Promise<ModelChoiceOutcome> => {
    const { plan, existing, target, newCredential } = input;
    setPending(true);
    try {
      const minted = newCredential
        ? await createCredential.mutateAsync({
            body: {
              label: newCredential.label,
              providerId: newCredential.providerId,
              api_key: newCredential.apiKey,
              ...(newCredential.baseUrlOverride
                ? { base_url_override: newCredential.baseUrlOverride }
                : {}),
            },
          })
        : null;
      const credentialId = minted?.id ?? target.credentialId;

      const failedModelIds: string[] = [];
      const idByModelId = new Map(existing.map((m) => [m.modelId, m.id]));
      for (const row of plan.add) {
        try {
          const created = await createModel.mutateAsync({
            body: {
              ...rowToEntry(row),
              credentialId,
              ...(credentialId === null ? { providerId: target.providerId } : {}),
            },
          });
          idByModelId.set(row.id, created.id);
        } catch {
          failedModelIds.push(row.id);
        }
      }
      for (const model of plan.remove) {
        try {
          await deleteModel.mutateAsync({ params: { path: { id: model.id } } });
        } catch {
          failedModelIds.push(model.modelId ?? model.id);
        }
      }
      const defaultId = plan.defaultModelId ? idByModelId.get(plan.defaultModelId) : undefined;
      if (defaultId) {
        try {
          await setDefault.mutateAsync({ body: { modelId: defaultId } });
        } catch {
          failedModelIds.push(plan.defaultModelId!);
        }
      }
      return { failedModelIds, credentialId: minted?.id ?? null };
    } finally {
      setPending(false);
    }
  };

  return { apply, isPending };
}
