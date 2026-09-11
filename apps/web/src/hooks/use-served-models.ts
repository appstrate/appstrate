// SPDX-License-Identifier: Apache-2.0

/**
 * Which models a subscription credential actually serves, asked of the live
 * endpoint (a plan's model list drifts while the credential does not). Three
 * states: a listing, a refusal (`"failed"`, so the form can say so and offer a
 * retry), and "still asking". Answers are cached per credential id so A → B →
 * A does not re-ask, and the effect fires only for an id the cache lacks.
 */

import { useCallback, useEffect, useState } from "react";
import { useRefreshCredentialModels } from "./use-model-provider-credentials";

export type ServedModelsCache = Record<string, string[] | "failed">;

/** `known` is the firing rule: an id present in the cache, listing OR refusal, is not asked again. */
export function servedModelsState(
  cache: ServedModelsCache,
  credentialId: string | null,
): { modelIds: string[] | null; failed: boolean; known: boolean } {
  const answer = credentialId === null ? undefined : cache[credentialId];
  return {
    modelIds: Array.isArray(answer) ? answer : null,
    failed: answer === "failed",
    known: answer !== undefined,
  };
}

export function forgetServedModels(
  cache: ServedModelsCache,
  credentialId: string,
): ServedModelsCache {
  const { [credentialId]: _dropped, ...rest } = cache;
  return rest;
}

export function useServedModels(credentialId: string | null): {
  /** The ids reported, or `null` while the call is in flight. */
  modelIds: string[] | null;
  failed: boolean;
  retry: () => void;
} {
  const refresh = useRefreshCredentialModels();
  const [cache, setCache] = useState<ServedModelsCache>({});
  const { modelIds, failed, known } = servedModelsState(cache, credentialId);

  useEffect(() => {
    if (!credentialId || known) return;
    refresh.mutate(
      { params: { path: { id: credentialId } } },
      {
        onSuccess: (data) =>
          setCache((c) => ({ ...c, [credentialId]: data.available_model_ids ?? [] })),
        onError: () => setCache((c) => ({ ...c, [credentialId]: "failed" })),
      },
    );
    // `refresh` is a fresh object every render; depending on `known` rather than
    // the cache keeps another credential's answer from re-firing this one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentialId, known]);

  const retry = useCallback(() => {
    if (credentialId) setCache((c) => forgetServedModels(c, credentialId));
  }, [credentialId]);

  return { modelIds, failed, retry };
}
