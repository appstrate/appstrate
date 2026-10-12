// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useDeleteModel, useSetDefaultModel } from "./use-models";
import { useDeleteModelProviderCredential } from "./use-model-provider-credentials";
import { ApiError } from "../api/errors";
import { refusalMessage } from "../lib/mutation-error";
import type { KeyDeletionPlan } from "../lib/key-deletion";

/** What a deletion left behind, for the confirmation to say. `done` closes it. */
export type KeyDeletionOutcome =
  | { status: "done" }
  /** The new default was refused: nothing else was touched (a toast says why). */
  | { status: "default-refused" }
  /** Some models could not be deleted, so the key stays. */
  | { status: "models-left"; removed: string[]; failed: string[]; refusal: string | null }
  /** Every model is gone, the key was refused. */
  | { status: "key-left"; removed: string[]; refusal: string | null };

function refusalOf(err: unknown): string | null {
  return err instanceof ApiError ? refusalMessage(err) : null;
}

/**
 * Deletes an organization key in one gesture: the new default first when the key served the
 * default, then the key's model rows (the foreign key refuses the key while they exist), then the
 * key. A step that fails stops the next ones, and the outcome says what was done and what is left.
 */
export function useDeleteOrgKey() {
  const setDefault = useSetDefaultModel();
  const deleteModel = useDeleteModel();
  const deleteCredential = useDeleteModelProviderCredential({ errorHandledByCaller: true });
  const [isPending, setPending] = useState(false);

  const run = async (input: {
    credentialId: string;
    plan: KeyDeletionPlan;
    /** The model that becomes the default when the key served it. */
    newDefaultId: string | null;
  }): Promise<KeyDeletionOutcome> => {
    const { credentialId, plan, newDefaultId } = input;
    setPending(true);
    try {
      if (plan.defaultModel && newDefaultId) {
        try {
          await setDefault.mutateAsync({ body: { modelId: newDefaultId } });
        } catch {
          return { status: "default-refused" };
        }
      }
      const removed: string[] = [];
      const failed: string[] = [];
      let refusal: string | null = null;
      for (const model of plan.doomed) {
        try {
          await deleteModel.mutateAsync({ params: { path: { id: model.id } } });
          removed.push(model.label);
        } catch (err) {
          failed.push(model.label);
          refusal ??= refusalOf(err);
        }
      }
      if (failed.length > 0) return { status: "models-left", removed, failed, refusal };
      try {
        await deleteCredential.mutateAsync({ params: { path: { id: credentialId } } });
      } catch (err) {
        return { status: "key-left", removed, refusal: refusalOf(err) };
      }
      return { status: "done" };
    } finally {
      setPending(false);
    }
  };

  return { run, isPending };
}
