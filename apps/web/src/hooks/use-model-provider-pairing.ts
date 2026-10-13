// SPDX-License-Identifier: Apache-2.0

/**
 * React Query hooks for the front-end-initiated OAuth model-provider
 * pairing flow. The dashboard mints a pairing token, surfaces the
 * matching `npx @appstrate/connect-helper <token>` command to the user,
 * and polls the pairing until the server states the outcome of the helper's
 * redeem: `connected` (the OAuth dance completed and the credential is stored),
 * `failed` (the redeem was refused), or `expired`.
 *
 * The dashboard never cancels a pairing when its modal closes (that dropped
 * in-flight connections); abandoned tokens are reaped by their TTL (5 min).
 */

import { $api } from "../api/client";
import { usePermissions } from "./use-permissions";

export function useCreateModelProviderPairing() {
  return $api.useMutation("post", "/api/model-providers-oauth/pairing", {
    meta: { errorHandledByCaller: true },
  });
}

/**
 * Poll a pairing's status. `id: null` polls nothing.
 *
 * Polls every 2.5s while the status is `pending`; it stops on a terminal one
 * (connected / failed / expired) and on any errored request.
 */
export function useModelProviderPairingStatus(id: string | null) {
  // Guarded like the route: either permission that mints a pairing reads it. A
  // role preview can drop both mid-poll.
  const { can } = usePermissions();
  const mayRead =
    can("model-provider-credentials:write") || can("model-provider-credentials:connect");
  return $api.useQuery(
    "get",
    "/api/model-providers-oauth/pairing/{id}",
    { params: { path: { id: id ?? "" } } },
    {
      enabled: !!id && mayRead,
      refetchInterval: (q) => {
        // Any errored request is terminal for the poll: the TTL reap surfaces
        // as 404, but auth/permission/server failures (401/403/5xx, or a
        // network error with no status) are equally non-recoverable here.
        if (q.state.error) return false;
        const status = q.state.data?.status;
        return !status || status === "pending" ? 2500 : false;
      },
      // Pairing rows are short-lived ephemera — no point caching beyond the
      // polling window. Always refetch on mount so closing+reopening the
      // modal can't see a stale "connected" hit from a prior session.
      staleTime: 0,
      gcTime: 0,
    },
  );
}
