// SPDX-License-Identifier: Apache-2.0

/**
 * R1 — user-scope connection mutations.
 *
 * The unified `/preferences/connections` page (now backed by
 * `useMyConnections()`) lists a user's connections across every org/app
 * they belong to. The mutation endpoints are app-scoped (X-Application-Id
 * is part of every connection write path) so each mutation here passes
 * the entry's own org/application as explicit headers — overriding the
 * SPA's currently-active context for that single request.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getErrorMessage } from "@appstrate/core/errors";
import i18n from "../i18n";
import { $api, client } from "../api/client";
import { onMutationError } from "./use-mutations";

/**
 * Unified user-scope connection list (integration connections), grouped by
 * source package. Backs the `/preferences/connections` page. Crosses
 * orgs/applications: no header context required (the `/api/me/*` routes are
 * deliberately org-context-free).
 */
export function useMyConnections() {
  return $api.useQuery("get", "/api/me/connections", {}, { select: (e) => e.data });
}

interface OrgAppHeaders {
  orgId: string;
  applicationId: string;
}

function scopedHeaders({ orgId, applicationId }: OrgAppHeaders) {
  return {
    "X-Org-Id": orgId,
    "X-Application-Id": applicationId,
  };
}

/**
 * Destructive delete of an integration connection from the user-scope page.
 *
 * Uses the new `DELETE /api/me/connections/:id` endpoint — same effect
 * (row + cascades), but the action lives under `/me/*` so it's never
 * surfaced from an agent context. The legacy
 * `DELETE /api/integrations/:packageId/connections/:id` is deprecated and
 * no longer called from the UI.
 */
export function useDisconnectIntegrationConnection() {
  const qc = useQueryClient();
  return $api.useMutation("delete", "/api/me/connections/{connectionId}", {
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["get", "/api/me/connections"] });
      // Member pins anywhere referencing the deleted connection cascaded
      // server-side; refresh their cache so the picker re-fetches.
      void qc.invalidateQueries({ queryKey: ["get", "/api/me/integration-pins"] });
      // Legacy keys: the app-scoped per-integration cache (use-integrations)
      // and the member-pin picker cache are still on the legacy key scheme —
      // the agent page's reuse hints + accessible-connection lists need a
      // refresh too.
      void qc.invalidateQueries({ queryKey: ["integrations"] });
      void qc.invalidateQueries({ queryKey: ["me-integration-pins"] });
    },
    onError: (err: unknown) =>
      toast.error(i18n.t("error.prefix", { message: getErrorMessage(err) })),
  });
}

/**
 * Update an integration connection's label and/or `sharedWithOrg` flag from
 * the user-scope page. The entry's own org/app context is passed as explicit
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
      applicationId,
      label,
      sharedWithOrg,
    }: OrgAppHeaders & {
      packageId: string;
      connectionId: string;
      label?: string | null;
      sharedWithOrg?: boolean;
    }) => {
      const { data } = await client.PATCH(
        "/api/integrations/{packageId}/connections/{connectionId}",
        {
          params: {
            path: { packageId, connectionId },
            header: scopedHeaders({ orgId, applicationId }),
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
      void qc.invalidateQueries({ queryKey: ["get", "/api/me/connections"] });
      void qc.invalidateQueries({ queryKey: ["integrations"] });
      toast.success(i18n.t("settings:integration.connection.updated"));
    },
    onError: onMutationError,
  });
}
