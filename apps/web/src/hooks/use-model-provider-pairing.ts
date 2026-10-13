// SPDX-License-Identifier: Apache-2.0

/**
 * React Query hooks for the front-end-initiated OAuth model-provider
 * pairing flow. The dashboard mints a pairing token, surfaces the
 * matching `npx @appstrate/connect-helper <token>` command to the user,
 * and polls the pairing until the server states the outcome of the helper's
 * redeem: `connected` (the OAuth dance completed and the credential is stored),
 * `failed` (the redeem was refused), or `expired`. A pairing the server refuses
 * to state is `lost`.
 *
 * The dashboard never cancels a pairing: closing its modal leaves the helper
 * free to redeem it, and an abandoned token is reaped by its TTL (5 min).
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
 * Poll a pairing and state where the poll stands. `id: null` polls nothing.
 *
 * Polls every 2.5s while the state is `pending`, which a transient error (a
 * 5xx, a network failure) leaves standing; it stops on a terminal status
 * (connected / failed / expired) and on `lost`.
 */
export function useModelProviderPairingStatus(id: string | null): {
  state: PairingPollState;
  /** The credential the redeem created or reconnected; `null` unless `connected`. */
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
      // Pairing rows are short-lived ephemera — no point caching beyond the
      // polling window. Always refetch on mount so closing+reopening the
      // modal can't see a stale "connected" hit from a prior session.
      staleTime: 0,
      gcTime: 0,
    },
  );
  return { state: pairingPollState(data?.status, error), credentialId: data?.credentialId ?? null };
}
