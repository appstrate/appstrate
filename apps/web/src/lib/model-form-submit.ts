// SPDX-License-Identifier: Apache-2.0

/**
 * The ModelFormModal submission, minus React. A creation is ONE `POST /api/models/apply`: the
 * typed key, the models and their binding are written together or not at all, so a refusal leaves
 * nothing behind and a retry starts from a clean slate. Only an edit of a saved model is still a
 * `PATCH`, with the typed key (if any) minted first and reported back on failure so the retry
 * rebinds to it.
 *
 * The writes are injected rather than closed over, so the contract is assertable without a DOM.
 */

import type {
  ModelFormData,
  ModelFormModelEntry,
  ModelFormSubmission,
  ModelFormSubmitOutcome,
  NewCredentialBody,
} from "./model-form-payload.ts";
import { toCreateModelBody } from "./model-form-payload.ts";
import { ApiError } from "../api/errors.ts";
import type { ModelChoiceBody } from "../hooks/use-apply-model-choice.ts";

type ModelFormUpdateBody = Omit<ModelFormData, "newCredential">;

/** The writes a submission can make. */
export interface ModelFormWrites {
  applyChoice: (body: ModelChoiceBody) => Promise<unknown>;
  createCredential: (body: NewCredentialBody) => Promise<{ id: string }>;
  updateModel: (id: string, body: ModelFormUpdateBody) => Promise<unknown>;
}

/** One model of the form as an `add` entry of the choice: the binding rides on the choice itself. */
function toAddEntry(data: ModelFormData): ModelFormModelEntry {
  const {
    credentialId: _credentialId,
    providerId: _providerId,
    ...entry
  } = toCreateModelBody(data, null);
  return entry;
}

/** The credential of the choice: the typed key to mint, the picked one, or none (each member's own). */
function toChoiceCredential(data: ModelFormSubmission): ModelChoiceBody["credential"] {
  if (data.newCredential) {
    const { api_key, providerId, base_url_override } = data.newCredential;
    return {
      providerId,
      api_key,
      ...(base_url_override ? { base_url_override } : {}),
    };
  }
  return data.credentialId ? { id: data.credentialId } : null;
}

/**
 * What a refused choice reports back. The choice is atomic — nothing was written — so every entry
 * is still to submit, except the ones the server says the organization already holds.
 */
function refusalOutcome(err: unknown, modelIds: string[]): ModelFormSubmitOutcome {
  const duplicateModelIds: string[] = [];
  const refusedModelIds: string[] = [];
  let refusalCode: string | undefined;
  if (err instanceof ApiError) {
    const items = err.code === "validation_failed" ? (err.errors ?? []) : [];
    for (const item of items) {
      const { field, code } = (item ?? {}) as Record<string, unknown>;
      // `add.<i>` from the service, `add[<i>].<key>` from body validation.
      const at = typeof field === "string" ? Number(/^add(?:\.|\[)(\d+)/.exec(field)?.[1]) : NaN;
      const modelId = modelIds[at];
      if (modelId !== undefined && code === "model_already_added") duplicateModelIds.push(modelId);
      else {
        if (modelId !== undefined && !refusedModelIds.includes(modelId))
          refusedModelIds.push(modelId);
        if (typeof code === "string") refusalCode ??= code;
      }
    }
    if (items.length === 0) refusalCode = err.code;
  }
  return {
    failedModelIds: modelIds,
    duplicateModelIds,
    ...(refusalCode ? { refusalCode } : {}),
    ...(refusedModelIds.length > 0 ? { refusedModelIds } : {}),
  };
}

/** A creation is one `apply`; an edit is one `PATCH` (PUT preserves nulls that clear an override). */
export function submitModelForm(opts: {
  writes: ModelFormWrites;
  editModelId: string | null;
  onSuccess: () => void;
}) {
  return async (data: ModelFormSubmission): Promise<ModelFormSubmitOutcome> => {
    if (!("models" in data) && opts.editModelId) return edit(opts, opts.editModelId, data);

    const entries = "models" in data ? data.models : [toAddEntry(data)];
    const modelIds = entries.map((entry) => entry.modelId);
    const credential = toChoiceCredential(data);
    try {
      await opts.writes.applyChoice({
        credential,
        ...(credential === null && data.providerId !== undefined
          ? { providerId: data.providerId }
          : {}),
        add: entries,
      });
    } catch (err) {
      return refusalOutcome(err, modelIds);
    }
    opts.onSuccess();
    return { failedModelIds: [], duplicateModelIds: [] };
  };
}

async function edit(
  opts: { writes: ModelFormWrites; onSuccess: () => void },
  editModelId: string,
  data: ModelFormData,
): Promise<ModelFormSubmitOutcome> {
  const { newCredential, ...modelData } = data;
  let credentialId = data.credentialId;
  try {
    if (newCredential) credentialId = (await opts.writes.createCredential(newCredential)).id;
  } catch {
    return { failedModelIds: [data.modelId], duplicateModelIds: [] };
  }
  try {
    await opts.writes.updateModel(editModelId, { ...modelData, credentialId });
  } catch (err) {
    const refusal = refusalOutcome(err, [data.modelId]);
    return { ...refusal, ...(newCredential && credentialId ? { credentialId } : {}) };
  }
  opts.onSuccess();
  return { failedModelIds: [], duplicateModelIds: [], ...(credentialId ? { credentialId } : {}) };
}
