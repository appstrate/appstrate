// SPDX-License-Identifier: Apache-2.0

/**
 * R1 — user-scope connection mutations.
 *
 * The unified `/preferences/connections` page (now backed by
 * `useMyConnections()`) lists a user's connections across every org/space
 * they belong to. The mutation endpoints are space-scoped (X-Space-Id
 * is part of every connection write path) so each mutation here passes
 * the entry's own org/space as explicit headers — overriding the
 * SPA's currently-active context for that single request.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import i18n from "../i18n";
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

interface OrgSpaceHeaders {
  orgId: string;
  spaceId: string;
}

function scopedHeaders({ orgId, spaceId }: OrgSpaceHeaders) {
  return {
    "X-Org-Id": orgId,
    "X-Space-Id": spaceId,
  };
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
      // The caller's own schedule overrides drop the connection; a colleague's keep
      // its id and show it unavailable in their picker.
      invalidateSchedules(qc);
      // The connection list, the agent page's reuse hints and accessible-connection lists.
      void invalidateIntegrationQueries(qc);
    },
    // `connection_pinned` while an admin pin or the space default names it.
  });
}

/**
 * Update an integration connection's label and/or `sharedWithOrg` flag from
 * the user-scope page. The entry's own org/space context is passed as explicit
 * headers, overriding the SPA's active context for this single request.
 */
export function useUpdateMeIntegrationConnection() {
  const qc = useQueryClient();
  return useMutation({
    // 200 + the bare connection resource (#657).
    mutationFn: async ({
      packageId,
      connectionId,
      orgId,
      spaceId,
      label,
      sharedWithOrg,
    }: OrgSpaceHeaders & {
      packageId: string;
      connectionId: string;
      label?: string;
      sharedWithOrg?: boolean;
    }) => {
      const { data } = await client.PATCH(
        "/api/integrations/{packageId}/connections/{connectionId}",
        {
          params: {
            path: { packageId, connectionId },
            header: scopedHeaders({ orgId, spaceId }),
          },
          body: {
            ...(label !== undefined ? { label } : {}),
            ...(sharedWithOrg !== undefined ? { shared_with_org: sharedWithOrg } : {}),
          },
        },
      );
      return data;
    },
    onSuccess: () => {
      void invalidateIntegrationQueries(qc);
      toast.success(i18n.t("settings:integration.connection.updated"));
    },
  });
}
