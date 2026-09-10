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
  ModelFormMultiData,
  ModelFormSubmission,
  ModelFormSubmitOutcome,
} from "./model-form-payload.ts";
import { toCreateModelBody } from "./model-form-payload.ts";

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

/** `label` is omitted: the server derives and dedupes one. */
function credentialBody(credential: NonNullable<ModelFormData["newCredential"]>) {
  return {
    providerId: credential.providerId,
    apiKey: credential.apiKey,
    ...(credential.baseUrlOverride ? { baseUrlOverride: credential.baseUrlOverride } : {}),
  };
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
    return (await writes.createCredential(credentialBody(data.newCredential))).id;
  } catch {
    return null;
  }
}

/** No bulk create: one POST per entry, refusals collected rather than aborting. */
async function submitBatch(
  writes: ModelFormWrites,
  data: ModelFormMultiData,
  onSuccess: () => void,
): Promise<ModelFormSubmitOutcome> {
  const credentialId = await bindCredential(writes, data);
  if (!credentialId) return { failedModelIds: data.models.map((m) => m.modelId) };

  const failedModelIds: string[] = [];
  for (const entry of data.models) {
    try {
      await writes.createModel({ ...entry, credentialId });
    } catch {
      failedModelIds.push(entry.modelId);
    }
  }
  if (failedModelIds.length === 0) onSuccess();
  return { failedModelIds, credentialId };
}

/** A refusal (of the key or the model) is reported the way a batch reports its own. */
async function submitOne(
  writes: ModelFormWrites,
  data: ModelFormData,
  editModelId: string | null,
  onSuccess: () => void,
): Promise<ModelFormSubmitOutcome> {
  const credentialId = await bindCredential(writes, data);
  if (!credentialId) return { failedModelIds: [data.modelId] };

  try {
    if (editModelId) {
      const { newCredential: _, ...modelData } = data;
      await writes.updateModel(editModelId, { ...modelData, credentialId });
    } else {
      await writes.createModel(toCreateModelBody(data, credentialId));
    }
  } catch {
    return { failedModelIds: [data.modelId], credentialId };
  }
  onSuccess();
  return { failedModelIds: [] };
}

/** One submission handler over `writes` — a batch when the payload carries `models`. */
export function submitModelForm(opts: {
  writes: ModelFormWrites;
  editModelId: string | null;
  onSuccess: () => void;
}) {
  return (data: ModelFormSubmission): Promise<ModelFormSubmitOutcome> =>
    "models" in data
      ? submitBatch(opts.writes, data, opts.onSuccess)
      : submitOne(opts.writes, data, opts.editModelId, opts.onSuccess);
}
