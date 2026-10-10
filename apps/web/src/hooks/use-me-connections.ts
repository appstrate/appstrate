// SPDX-License-Identifier: Apache-2.0

/**
 * R1 — user-scope connection mutations.
 *
 * The unified `/preferences/connections` page (backed by `useMyConnections()`)
 * lists a user's connections across every org/space they belong to. Its writes
 * go through the owner-only `/api/me/connections/{connectionId}` routes, which
 * need no org/space context.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { $api, client } from "../api/client";
import { invalidateIntegrationQueries } from "./use-integrations";
import { invalidateSchedules } from "./use-schedules";

/**
 * Unified user-scope connection list (integration connections), grouped by
 * source package. Backs the `/preferences/connections` page. Crosses
 * orgs/spaces: no header context required (the `/api/me/*` routes are
 * deliberately org-context-free).
 */
export function useMyConnections() {
  return $api.useQuery("get", "/api/me/connections", {}, { select: (e) => e.data });
}

/** Fetches only while `connectionId` is set, i.e. while the confirmation is open. */
export function useConnectionDeleteImpact(connectionId: string | undefined) {
  return $api.useQuery(
    "get",
    "/api/me/connections/{connectionId}/delete-impact",
    { params: { path: { connectionId: connectionId ?? "" } } },
    // Never answered from cache: the user confirms on what this says, and a
    // pick made since the last open would be missing from it.
    { gcTime: 0, enabled: !!connectionId },
  );
}

/**
 * Destructive delete of an integration connection from the user-scope page.
 *
 * `DELETE /api/me/connections/:id` is the only endpoint that deletes a
 * connection (row + cascades). It lives under `/me/*` so the action is never
 * surfaced from an agent context.
 */
export function useDisconnectIntegrationConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { params: { path: { connectionId: string } } }) => {
      await client.DELETE("/api/me/connections/{connectionId}", vars);
    },
    onSuccess: () => {
      // The caller's own schedule overrides drop the connection; a colleague's schedule
      // naming it is disabled, its overrides kept.
      invalidateSchedules(qc);
      // The connection list, the agent page's reuse hints and accessible-connection lists.
      void invalidateIntegrationQueries(qc);
    },
  });
}

/**
 * Rename the caller's own connection and/or replace the set of spaces it is
 * shared into, from the user-scope page.
 */
export function useUpdateMeIntegrationConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      connectionId,
      body,
    }: {
      connectionId: string;
      body: { label?: string; shared_space_ids?: string[] };
    }) => {
      const { data } = await client.PATCH("/api/me/connections/{connectionId}", {
        params: { path: { connectionId } },
        body,
      });
      return data;
    },
    onSuccess: (_data, { body }) => {
      // Unsharing disables other people's schedules naming the connection.
      if (body.shared_space_ids) invalidateSchedules(qc);
      // Returned: the mutation stays pending until the list refetch lands, so the
      // share editor never re-enables on a stale `shared_space_ids` (next pick would drop one).
      return invalidateIntegrationQueries(qc);
    },
  });
}
