// SPDX-License-Identifier: Apache-2.0

/**
 * Which models a subscription credential actually serves.
 *
 * A plan's model list drifts while the credential does not, so this asks the
 * live endpoint rather than reading the persisted `available_model_ids`: what
 * the call just reported is the only thing the picker offers. What the endpoint
 * DOES depends on the provider's discovery mode — `mode: "static"` derives the
 * list server-side from the definition ∩ catalog with zero requests, anything
 * else reads the provider's `GET /models` once — and both answer in the same
 * shape, so there is one code path here.
 *
 * Three states, not two: a listing, a refusal, and "still asking". A refusal
 * used to be recorded as an empty listing, which reads on screen as "this plan
 * serves nothing" — the operator's mistake to fix rather than a call to retry.
 * `"failed"` is stored as its own answer so the form can say so and offer the
 * retry that clears it.
 *
 * The answers are cached per credential id, and the effect fires for an id the
 * cache does not hold. That is what makes A → B → A work: a one-slot cache
 * answered `null` for the second A (its slot names B) while nothing was in
 * flight to fill it, and the picker spun forever.
 */

import { useCallback, useEffect, useState } from "react";
import { useRefreshCredentialModels } from "./use-model-provider-credentials";

/** One answer per credential id: what it serves, or that asking failed. */
export type ServedModelsCache = Record<string, string[] | "failed">;

/**
 * What the hook reports for one credential, and whether the effect still has
 * to ask. `known` is the whole firing rule: an id absent from the cache is
 * asked about, an id present in it — listing OR refusal — is not.
 */
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

/** Drop one credential's answer, which is what makes the effect ask again. */
export function forgetServedModels(
  cache: ServedModelsCache,
  credentialId: string,
): ServedModelsCache {
  const { [credentialId]: _dropped, ...rest } = cache;
  return rest;
}

export function useServedModels(credentialId: string | null): {
  /** The ids the call reported, or `null` while it is still in flight. */
  modelIds: string[] | null;
  /** The call was refused or never landed — nothing was reported, at all. */
  failed: boolean;
  /** Forget this credential's answer and ask again. */
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
    // `refresh` is a fresh object every render; `known` is what bounds the
    // call, so re-running on its identity would only add noise. Depending on
    // `known` rather than on the whole cache is deliberate: another
    // credential's answer landing must not re-fire the one in flight here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentialId, known]);

  const retry = useCallback(() => {
    if (credentialId) setCache((c) => forgetServedModels(c, credentialId));
  }, [credentialId]);

  return { modelIds, failed, retry };
}
