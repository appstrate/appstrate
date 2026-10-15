// SPDX-License-Identifier: Apache-2.0

/**
 * Hooks for the OAuth model-provider pairing flow: the dashboard mints a token, shows the
 * `npx @appstrate/connect-helper <token>` command, and polls until the server states the
 * redeem's outcome (`connected`, `failed` or `expired`).
 */

import { $api } from "../api/client";
import { pairingPollState, type PairingPollState } from "../lib/oauth-pairing";
import { usePermissions } from "./use-permissions";

export function useCreateModelProviderPairing() {
  return $api.useMutation("post", "/api/model-providers-oauth/pairing", {
    meta: { errorHandledByCaller: true },
  });
}

export function useModelProviderPairingStatus(id: string | null): {
  state: PairingPollState;
  credentialId: string | null;
} {
  // Guarded like the route; a role preview can drop both permissions mid-poll.
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
