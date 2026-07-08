// SPDX-License-Identifier: Apache-2.0

/**
 * React Query hooks for the front-end-initiated OAuth model-provider
 * pairing flow. The dashboard mints a pairing token, surfaces the
 * matching `npx @appstrate/connect-helper <token>` command to the user,
 * and polls the pairing's status until it flips from `pending` to
 * `consumed` (= the helper completed the OAuth dance and POSTed the
 * credentials back).
 *
 * The dashboard no longer cancels a pairing when its modal closes (that
 * dropped in-flight connections); abandoned tokens are reaped by their TTL
 * (5 min). `useCancelModelProviderPairing` remains as the binding for the
 * DELETE endpoint but is not used by the modal-close path.
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
 * as the status transitions to a terminal state (consumed / expired), or
 * the row is gone (404/410 once the TTL reaps it server-side) — otherwise
 * an expired pairing would spin the poll until the client-side prune drops
 * it from the store.
 */
export function useModelProviderPairingStatus(id: string | null, options: { enabled: boolean }) {
  return $api.useQuery(
    "get",
    "/api/model-providers-oauth/pairing/{id}",
    { params: { path: { id: id ?? "" } } },
    {
      enabled: options.enabled && !!id,
      refetchInterval: (q) => {
        // Any errored request is terminal for the poll: the TTL reap surfaces
        // as 404/410, but auth/permission/server failures (401/403/5xx, or a
        // network error with no status) are equally non-recoverable here —
        // keep spinning only while the request is succeeding and pending.
        if (q.state.error) return false;
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
