// SPDX-License-Identifier: Apache-2.0

/**
 * R1 — user-scope connection mutations.
 *
 * The unified `/preferences/connectors` page (now backed by
 * `useMyConnections()`) lists a user's connections across every org/app
 * they belong to. The mutation endpoints are app-scoped (X-Application-Id
 * is part of every connection write path) so each mutation here passes
 * the entry's own org/application as explicit headers — overriding the
 * SPA's currently-active context for that single request.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import i18n from "../i18n";
import { api, apiList } from "../api";
import type { MeConnectionSourceGroup } from "@appstrate/shared-types";
import { onMutationError } from "./use-mutations";

/**
 * Unified user-scope connection list (integration connections), grouped by
 * source package. Backs the `/preferences/connectors` page. Crosses
 * orgs/applications: no header context required.
 */
export function useMyConnections() {
  return useQuery({
    queryKey: ["me-connections"],
    queryFn: () => apiList<MeConnectionSourceGroup>("/me/connections"),
  });
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
 *
 * `packageId` is unused at the network layer (the new endpoint derives
 * applicationId from the connection row itself) but kept in the signature
 * so the page-level call site doesn't need refactoring.
 */
export function useDisconnectIntegrationConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ connectionId }: OrgAppHeaders & { packageId: string; connectionId: string }) =>
      api<void>(`/me/connections/${connectionId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me-connections"] });
      // Invalidate the app-scoped per-integration cache too — the agent
      // page's reuse hints + accessible-connection lists need a refresh.
      qc.invalidateQueries({ queryKey: ["integrations"] });
      // Member pins anywhere referencing the deleted connection cascaded
      // server-side; refresh their cache so the picker re-fetches.
      qc.invalidateQueries({ queryKey: ["me-integration-pins"] });
    },
    onError: onMutationError,
  });
}

/**
 * Update an integration connection's label and/or `sharedWithOrg` flag from
 * the user-scope page.
 */
export function useUpdateMeIntegrationConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
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
    }) =>
      api<{ id: string; label: string | null; sharedWithOrg: boolean }>(
        `/integrations/${encodeURI(packageId)}/connections/${connectionId}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            ...(label !== undefined ? { label } : {}),
            ...(sharedWithOrg !== undefined ? { sharedWithOrg } : {}),
          }),
          headers: {
            "Content-Type": "application/json",
            ...scopedHeaders({ orgId, applicationId }),
          },
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me-connections"] });
      qc.invalidateQueries({ queryKey: ["integrations"] });
      toast.success(i18n.t("settings:integration.connection.updated"));
    },
    onError: onMutationError,
  });
}
