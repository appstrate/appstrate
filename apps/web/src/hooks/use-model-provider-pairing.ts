// SPDX-License-Identifier: Apache-2.0

/**
 * React Query hooks for the front-end-initiated OAuth model-provider
 * pairing flow. The dashboard mints a pairing token, surfaces the
 * matching `npx @appstrate/connect-helper <token>` command to the user,
 * and polls the pairing until the server states the outcome of the helper's
 * redeem: `connected` (the OAuth dance completed and the credential is stored),
 * `failed` (the redeem was refused), or `expired`.
 */

import { $api } from "../api/client";
import { pairingPollState, type PairingPollState } from "../lib/oauth-pairing";
import { usePermissions } from "./use-permissions";

export function useCreateModelProviderPairing() {
  return $api.useMutation("post", "/api/model-providers-oauth/pairing", {
    meta: { errorHandledByCaller: true },
  });
}

/**
 * Poll a pairing's status. `id: null` polls nothing.
 */
export function useModelProviderPairingStatus(id: string | null): {
  state: PairingPollState;
  credentialId: string | null;
} {
  // Guarded like the route: either permission that mints a pairing reads it. A
  // role preview can drop both mid-poll.
  const { can } = usePermissions();
  const mayRead =
    can("model-provider-credentials:write") || can("model-provider-credentials:connect");
  const { data, error } = $api.useQuery(
    "get",
    "/api/model-providers-oauth/pairing/{id}",
    { params: { path: { id: id ?? "" } } },
    {
      enabled: !!id && mayRead,
      refetchInterval: (q) =>
        pairingPollState(q.state.data?.status, q.state.error) === "pending" ? 2500 : false,
      // The next tick is the retry: React Query's own would double each failed tick.
      retry: false,
      // A pairing's status means something only while observed: nothing is cached past that.
      staleTime: 0,
      gcTime: 0,
    },
  );
  return { state: pairingPollState(data?.status, error), credentialId: data?.credentialId ?? null };
}
