// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import {
  useCreateModel,
  useSetDefaultModel,
  useUpdateModel,
  type OrgModelInfo,
} from "./use-models";
import { useCreateModelProviderCredential } from "./use-model-provider-credentials";
import { rowToEntry } from "../lib/model-form-payload";
import { refusalMessage } from "../lib/mutation-error";
import { ApiError } from "../api/errors";
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
  /** The upstream ids whose creation, activation or deactivation was refused. */
  failedModelIds: string[];
  /** What the server said of the first refusal it has a sentence for, else `null`. */
  refusal: string | null;
  /** The key minted, to bind a retry to instead of minting a second one. */
  credentialId: string | null;
  /** The models created, so a retry knows them (a new key's models are not in the dialog's list). */
  createdModels: OrgModelInfo[];
}

/**
 * Applies a {@link ModelChoicePlan}: the key first when there is one to mint, then each model
 * created or switched back on, then the default, then each model switched off (a model is never
 * deleted from here, and the default moves first so the one it leaves can be switched off).
 * A refusal of the key rejects (nothing was written); a refusal of a model is reported in the
 * outcome, and the rest still go through.
 */
export function useApplyModelChoice() {
  const createModel = useCreateModel();
  const updateModel = useUpdateModel();
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
      let refusal: string | null = null;
      const fail = (modelId: string, err: unknown) => {
        failedModelIds.push(modelId);
        if (refusal === null && err instanceof ApiError) refusal = refusalMessage(err);
      };
      const setEnabled = async (model: OrgModelInfo, enabled: boolean) => {
        try {
          await updateModel.mutateAsync({
            params: { path: { id: model.id } },
            body: { enabled },
          });
        } catch (err) {
          fail(model.modelId ?? model.id, err);
        }
      };
      const idByModelId = new Map(existing.map((m) => [m.modelId, m.id]));
      const createdModels: OrgModelInfo[] = [];
      let defaulted: string | undefined;
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
          createdModels.push(created);
        } catch (err) {
          fail(row.id, err);
        }
      }
      for (const model of plan.grant) await setEnabled(model, true);
      const defaultId = plan.defaultModelId ? idByModelId.get(plan.defaultModelId) : undefined;
      if (defaultId) {
        try {
          await setDefault.mutateAsync({ body: { modelId: defaultId } });
          defaulted = defaultId;
        } catch (err) {
          fail(plan.defaultModelId!, err);
        }
      }
      for (const model of plan.withdraw) await setEnabled(model, false);
      return {
        failedModelIds,
        refusal,
        credentialId: minted?.id ?? null,
        // The rows as the server holds them now: the one starred is the default.
        createdModels: createdModels.map((m) =>
          m.id === defaulted ? { ...m, is_default: true } : m,
        ),
      };
    } finally {
      setPending(false);
    }
  };

  return { apply, isPending };
}
