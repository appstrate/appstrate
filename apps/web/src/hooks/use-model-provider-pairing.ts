// SPDX-License-Identifier: Apache-2.0

/**
 * React Query hooks for the front-end-initiated OAuth model-provider
 * pairing flow. The dashboard mints a pairing token, surfaces the
 * matching `npx @appstrate/connect-helper <token>` command to the user,
 * and polls the pairing's status until it flips from `pending` to
 * `consumed` (= the helper completed the OAuth dance and POSTed the
 * credentials back).
 *
 * Cancellation on modal close is best-effort — the token TTL (5 min) is
 * the safety net if the DELETE never lands.
 */

import { $api, type paths } from "../api/client";

/** Wire shape of `POST /api/model-providers-oauth/pairing` (200). */
export type PairingCreateResponse =
  paths["/api/model-providers-oauth/pairing"]["post"]["responses"][200]["content"]["application/json"];

/** Wire shape of `GET /api/model-providers-oauth/pairing/{id}` (200). */
export type PairingStatus =
  paths["/api/model-providers-oauth/pairing/{id}"]["get"]["responses"][200]["content"]["application/json"];

export function useCreateModelProviderPairing() {
  return $api.useMutation("post", "/api/model-providers-oauth/pairing");
}

/**
 * Poll a pairing's status. `enabled` is the only way to start/stop the
 * polling — the hook itself is unconditionally registered so the
 * surrounding component re-renders deterministically.
 *
 * `refetchInterval` is set to 2.5s when polling; we stop polling as soon
 * as the status transitions to a terminal state (consumed / expired).
 */
export function useModelProviderPairingStatus(id: string | null, options: { enabled: boolean }) {
  return $api.useQuery(
    "get",
    "/api/model-providers-oauth/pairing/{id}",
    { params: { path: { id: id ?? "" } } },
    {
      enabled: options.enabled && !!id,
      refetchInterval: (q) => {
        const data = q.state.data;
        if (!data) return 2500;
        if (data.status === "pending") return 2500;
        return false;
      },
      // Pairing rows are short-lived ephemera — no point caching beyond the
      // polling window. Always refetch on mount so closing+reopening the
      // modal can't see a stale "consumed" hit from a prior session.
      staleTime: 0,
      gcTime: 0,
    },
  );
}

export function useCancelModelProviderPairing() {
  return $api.useMutation("delete", "/api/model-providers-oauth/pairing/{id}");
}
