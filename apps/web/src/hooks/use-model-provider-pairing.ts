// SPDX-License-Identifier: Apache-2.0

/**
 * React Query hooks for the front-end-initiated OAuth model-provider
 * pairing flow. The dashboard mints a pairing token, surfaces the
 * matching `npx @appstrate/connect-helper <token>` command to the user,
 * and polls the pairing until the helper's redeem links a credential to it
 * (the OAuth dance completed and the credentials were stored), is refused, or
 * the token expires.
 *
 * The dashboard never cancels a pairing when its modal closes (that dropped
 * in-flight connections); abandoned tokens are reaped by their TTL (5 min).
 */

import { useEffect, useState } from "react";
import { $api } from "../api/client";
import { usePermissions } from "./use-permissions";
import {
  PAIRING_LINK_WAIT_MS,
  pairingOutcome,
  pairingPollContinues,
  type PairingOutcome,
} from "../lib/pairing-outcome";

export function useCreateModelProviderPairing() {
  return $api.useMutation("post", "/api/model-providers-oauth/pairing", {
    meta: { errorHandledByCaller: true },
  });
}

/**
 * Poll a pairing to its outcome. `id: null` polls nothing.
 *
 * Polls every 2.5s while the outcome is `waiting`: a pending pairing, and a
 * consumed one whose credential is not linked yet. It stops on a connected or
 * expired pairing, on a failed one (consumed, still without a credential after
 * `PAIRING_LINK_WAIT_MS`), and on any errored request.
 */
export function useModelProviderPairingOutcome(id: string | null): {
  outcome: PairingOutcome;
  credentialId: string | null;
} {
  // Guarded like the route: either permission that mints a pairing reads it. A
  // role preview can drop both mid-poll.
  const { can } = usePermissions();
  const mayRead =
    can("model-provider-credentials:write") || can("model-provider-credentials:connect");
  /** The pairing that stayed consumed without a credential for the whole wait. */
  const [failedId, setFailedId] = useState<string | null>(null);
  const failed = id !== null && failedId === id;

  const { data } = $api.useQuery(
    "get",
    "/api/model-providers-oauth/pairing/{id}",
    { params: { path: { id: id ?? "" } } },
    {
      enabled: !!id && mayRead && !failed,
      refetchInterval: (q) => {
        // Any errored request is terminal for the poll: the TTL reap surfaces
        // as 404/410, but auth/permission/server failures (401/403/5xx, or a
        // network error with no status) are equally non-recoverable here.
        if (q.state.error) return false;
        return pairingPollContinues(q.state.data) ? 2500 : false;
      },
      // Pairing rows are short-lived ephemera — no point caching beyond the
      // polling window. Always refetch on mount so closing+reopening the
      // modal can't see a stale "consumed" hit from a prior session.
      staleTime: 0,
      gcTime: 0,
    },
  );

  const unlinked = data?.status === "consumed" && !data.credentialId;
  useEffect(() => {
    if (!unlinked || !id) return;
    const handle = setTimeout(() => setFailedId(id), PAIRING_LINK_WAIT_MS);
    return () => clearTimeout(handle);
  }, [unlinked, id]);

  return {
    outcome: pairingOutcome(data, failed ? PAIRING_LINK_WAIT_MS : 0),
    credentialId: data?.credentialId ?? null,
  };
}
