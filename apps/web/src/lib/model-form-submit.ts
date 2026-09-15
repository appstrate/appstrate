// SPDX-License-Identifier: Apache-2.0

/**
 * The ModelFormModal submission, minus React: mint the inline key if there is
 * one, then run the create(s) or the update against it.
 *
 * The writes are injected rather than closed over, so the retry contract this
 * flow exists to hold is assertable without a DOM. That contract: once the
 * typed key has been minted, every later refusal reports the credential back,
 * because the modal re-submits with the same `newCredential` still in the form
 * — nothing to rebind to means a second credential holding the same secret and
 * a first one referenced by no model.
 */

import type {
  ModelFormData,
  ModelFormModelEntry,
  ModelFormSubmission,
  ModelFormSubmitOutcome,
} from "./model-form-payload.ts";
import { toCreateModelBody } from "./model-form-payload.ts";
import { ApiError } from "../api/errors.ts";

/**
 * `POST /api/models` refuses a (credential, model) pair the organization
 * already holds — one row per binding, or `llm_usage` splits that model's spend
 * across the copies. Reported apart from a real failure: nothing to retry.
 */
function isDuplicate(err: unknown): boolean {
  return err instanceof ApiError && err.code === "model_already_added";
}

export type ModelFormCreateBody = ModelFormModelEntry & { credentialId: string };
type ModelFormUpdateBody = Omit<ModelFormData, "newCredential">;

/** The three writes a submission can make. */
export interface ModelFormWrites {
  createCredential: (body: {
    providerId: string;
    apiKey: string;
    baseUrlOverride?: string;
  }) => Promise<{ id: string }>;
  createModel: (body: ModelFormCreateBody) => Promise<unknown>;
  updateModel: (id: string, body: ModelFormUpdateBody) => Promise<unknown>;
}

/**
 * The credential the model(s) bind to: the picked one, or the typed key created
 * first — or `null` when minting that key was itself refused, which is the one
 * case where a retry has nothing to rebind to.
 */
async function bindCredential(
  writes: ModelFormWrites,
  data: ModelFormSubmission,
): Promise<string | null> {
  if (!data.newCredential) return data.credentialId;
  try {
    return (await writes.createCredential(data.newCredential)).id;
  } catch {
    return null;
  }
}

/** One POST per entry; PUT preserves nulls that clear an existing override. */
export function submitModelForm(opts: {
  writes: ModelFormWrites;
  editModelId: string | null;
  onSuccess: () => void;
}) {
  return async (data: ModelFormSubmission): Promise<ModelFormSubmitOutcome> => {
    const entries = "models" in data ? data.models : [toCreateModelBody(data, data.credentialId)];
    const credentialId = await bindCredential(opts.writes, data);
    if (!credentialId) {
      return { failedModelIds: entries.map((entry) => entry.modelId), duplicateModelIds: [] };
    }

    const failedModelIds: string[] = [];
    const duplicateModelIds: string[] = [];
    for (const entry of entries) {
      try {
        if (!("models" in data) && opts.editModelId) {
          const { newCredential: _, ...modelData } = data;
          await opts.writes.updateModel(opts.editModelId, { ...modelData, credentialId });
        } else {
          await opts.writes.createModel({ ...entry, credentialId });
        }
      } catch (err) {
        failedModelIds.push(entry.modelId);
        if (isDuplicate(err)) duplicateModelIds.push(entry.modelId);
      }
    }
    if (failedModelIds.length === 0) opts.onSuccess();
    return { failedModelIds, duplicateModelIds, credentialId };
  };
}
