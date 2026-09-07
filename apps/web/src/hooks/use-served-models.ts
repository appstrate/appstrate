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
 * One call per credential per form-open: the hook is mounted by the form body,
 * which remounts on every open, so reopening the modal always re-asks.
 */

import { useEffect, useRef, useState } from "react";
import { useRefreshCredentialModels } from "./use-model-provider-credentials";

export function useServedModels(credentialId: string | null): {
  /** The ids the call reported, or `null` while it is still in flight. */
  modelIds: string[] | null;
} {
  const refresh = useRefreshCredentialModels();
  const [served, setServed] = useState<{ id: string; modelIds: string[] } | null>(null);
  const attempted = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!credentialId || attempted.current.has(credentialId)) return;
    attempted.current.add(credentialId);
    refresh.mutate(
      { params: { path: { id: credentialId } } },
      {
        onSuccess: (data) =>
          setServed({ id: credentialId, modelIds: data.available_model_ids ?? [] }),
        // A refusal is an answer too: nothing served, rather than a spinner
        // that never resolves.
        onError: () => setServed({ id: credentialId, modelIds: [] }),
      },
    );
    // `refresh` is a fresh object every render; the ref above is what bounds
    // the call, so re-running on its identity would only add noise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentialId]);

  return { modelIds: served?.id === credentialId ? served.modelIds : null };
}
