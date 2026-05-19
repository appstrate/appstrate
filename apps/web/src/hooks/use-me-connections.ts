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

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import i18n from "../i18n";
import { api, apiFetch } from "../api";
import { invalidateConnectionRelated } from "./invalidation";
import { onMutationError } from "./use-mutations";

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
 * Disconnect a provider connection from the user-scope page. Uses the
 * entry's own org/app headers so the call works regardless of the SPA's
 * currently-active org.
 */
export function useDisconnectProviderConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      providerId,
      connectionId,
      orgId,
      applicationId,
    }: OrgAppHeaders & { providerId: string; connectionId: string }) =>
      apiFetch(`/api/connections/${providerId}?connectionId=${connectionId}`, {
        method: "DELETE",
        headers: scopedHeaders({ orgId, applicationId }),
      }),
    onSuccess: () => {
      invalidateConnectionRelated(qc);
      qc.invalidateQueries({ queryKey: ["me-connections"] });
    },
    onError: onMutationError,
  });
}

/**
 * Disconnect an integration connection from the user-scope page.
 */
export function useDisconnectIntegrationConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      packageId,
      connectionId,
      orgId,
      applicationId,
    }: OrgAppHeaders & { packageId: string; connectionId: string }) =>
      api<{ disconnected: boolean }>(
        `/integrations/${encodeURI(packageId)}/connections/${connectionId}`,
        {
          method: "DELETE",
          headers: scopedHeaders({ orgId, applicationId }),
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me-connections"] });
      // Invalidate the app-scoped per-integration cache too (defensive).
      qc.invalidateQueries({ queryKey: ["integrations"] });
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
