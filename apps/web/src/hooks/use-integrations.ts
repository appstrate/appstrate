// SPDX-License-Identifier: Apache-2.0

/**
 * React Query hooks for the AFPS integration marketplace (Phase 1.3).
 *
 * Hooks backed by `/api/integrations/*`. Query keys are app-scoped
 * (`[..., orgId, applicationId]`) so an org switch wipes the cache via
 * the standard `queryClient.removeQueries` flow in app.tsx.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import type {
  IntegrationConnection,
  IntegrationDetail,
  IntegrationOAuthClient,
  IntegrationRequiredScopes,
  IntegrationSummary,
} from "@appstrate/shared-types";
import { api, apiList, type ListEnvelope } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";

// Re-export wire types for component consumers — canonical definitions
// live in `@appstrate/shared-types/integrations.ts`.
export type {
  IntegrationAuthStatus,
  IntegrationAuthType,
  IntegrationConnection,
  IntegrationDetail,
  IntegrationManifestAuth,
  IntegrationManifestTool,
  IntegrationManifestView,
  IntegrationOAuthClient,
  IntegrationRequiredScopes,
  IntegrationSummary,
} from "@appstrate/shared-types";

// ─────────────────────────────────────────────
// Hooks
// ─────────────────────────────────────────────

const KEY = (orgId: string | null | undefined, applicationId: string | null | undefined) =>
  ["integrations", orgId ?? undefined, applicationId ?? undefined] as const;

export function useIntegrations() {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: [...KEY(orgId, applicationId), "all"] as const,
    enabled: Boolean(orgId && applicationId),
    queryFn: () => apiList<IntegrationSummary>("/integrations"),
  });
}

export function useIntegrationDetail(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: [...KEY(orgId, applicationId), "detail", packageId] as const,
    enabled: Boolean(orgId && applicationId && packageId),
    queryFn: () => api<IntegrationDetail>(`/integrations/${encodeURI(packageId!)}`),
  });
}

export function useIntegrationConnections(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: [...KEY(orgId, applicationId), "connections", packageId] as const,
    enabled: Boolean(orgId && applicationId && packageId),
    queryFn: async () => {
      const envelope = await api<ListEnvelope<IntegrationConnection>>(
        `/integrations/${encodeURI(packageId!)}/connections`,
      );
      return envelope.data;
    },
  });
}

/**
 * R3 — own + shared connections the actor could resolve to at run-kickoff.
 * Powers the pre-run picker rendered on agent surfaces when more than one
 * candidate exists (avoids the must_choose 412 recovery loop).
 */
export interface AccessibleIntegrationConnection {
  id: string;
  authKey: string;
  accountId: string;
  label: string | null;
  ownerUserId: string | null;
  ownerEndUserId: string | null;
  sharedWithOrg: boolean;
  needsReconnection: boolean;
}

export function useAccessibleIntegrationConnections(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: [...KEY(orgId, applicationId), "accessible-connections", packageId] as const,
    enabled: Boolean(orgId && applicationId && packageId),
    queryFn: async () => {
      const envelope = await api<ListEnvelope<AccessibleIntegrationConnection>>(
        `/integrations/${encodeURI(packageId!)}/accessible-connections`,
      );
      return envelope.data;
    },
  });
}

export function useInstallIntegration() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useMutation({
    mutationFn: (packageId: string) =>
      api<{ installed: boolean; installedAt: string }>(
        `/integrations/${encodeURI(packageId)}/install`,
        { method: "POST", body: "{}" },
      ),
    onSuccess: () => {
      toast.success(t("integrations.install.success"));
      qc.invalidateQueries({ queryKey: KEY(orgId, applicationId) });
    },
    onError: () => toast.error(t("integrations.install.error")),
  });
}

export function useUninstallIntegration() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useMutation({
    mutationFn: (packageId: string) =>
      api<{ uninstalled: boolean }>(`/integrations/${encodeURI(packageId)}/install`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success(t("integrations.uninstall.success"));
      qc.invalidateQueries({ queryKey: KEY(orgId, applicationId) });
    },
    onError: () => toast.error(t("integrations.uninstall.error")),
  });
}

export function useConnectIntegrationFields() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useMutation({
    mutationFn: ({
      packageId,
      authKey,
      credentials,
    }: {
      packageId: string;
      authKey: string;
      credentials: Record<string, string>;
    }) =>
      api<IntegrationConnection>(
        `/integrations/${encodeURI(packageId)}/auths/${encodeURI(authKey)}/connect/fields`,
        { method: "POST", body: JSON.stringify({ credentials }) },
      ),
    onSuccess: (_data, vars) => {
      toast.success(t("integration.connect.success"));
      qc.invalidateQueries({ queryKey: KEY(orgId, applicationId) });
      qc.invalidateQueries({
        queryKey: [...KEY(orgId, applicationId), "detail", vars.packageId],
      });
    },
    onError: () => toast.error(t("integration.connect.error")),
  });
}

/**
 * Niveau 2 Phase 5 — fetch the scope union the next OAuth kickoff will
 * request for `(packageId, authKey)`. Polled at integration-detail page
 * load so the UI can show a "Reconnect to grant additional permissions"
 * CTA when `missingFromGranted.length > 0` (incremental consent flow).
 */
export function useIntegrationRequiredScopes(
  packageId: string | undefined,
  authKey: string | undefined,
) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: [...KEY(orgId, applicationId), "required-scopes", packageId, authKey] as const,
    enabled: Boolean(orgId && applicationId && packageId && authKey),
    queryFn: () =>
      api<IntegrationRequiredScopes>(
        `/integrations/${encodeURI(packageId!)}/auths/${encodeURI(authKey!)}/required-scopes`,
      ),
  });
}

export function useInitiateIntegrationOAuth() {
  const { t } = useTranslation("settings");
  return useMutation({
    mutationFn: ({
      packageId,
      authKey,
      scopes,
    }: {
      packageId: string;
      authKey: string;
      scopes?: string[];
    }) =>
      api<{ authUrl: string; state: string }>(
        `/integrations/${encodeURI(packageId)}/auths/${encodeURI(authKey)}/connect/oauth2`,
        { method: "POST", body: JSON.stringify({ scopes: scopes ?? [] }) },
      ),
    onError: () => toast.error(t("integration.connect.error")),
  });
}

export function useDisconnectIntegration() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useMutation({
    mutationFn: ({ packageId, connectionId }: { packageId: string; connectionId: string }) =>
      api<{ disconnected: boolean }>(
        `/integrations/${encodeURI(packageId)}/connections/${connectionId}`,
        { method: "DELETE" },
      ),
    onSuccess: (_data, vars) => {
      toast.success(t("integration.connect.success"));
      qc.invalidateQueries({
        queryKey: [...KEY(orgId, applicationId), "detail", vars.packageId],
      });
      qc.invalidateQueries({
        queryKey: [...KEY(orgId, applicationId), "connections", vars.packageId],
      });
    },
  });
}

export function useIntegrationOAuthClient(
  packageId: string | undefined,
  authKey: string | undefined,
) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: [...KEY(orgId, applicationId), "oauth-client", packageId, authKey] as const,
    enabled: Boolean(orgId && applicationId && packageId && authKey),
    queryFn: async (): Promise<IntegrationOAuthClient | null> => {
      try {
        return await api<IntegrationOAuthClient>(
          `/integrations/${encodeURI(packageId!)}/oauth-clients/${encodeURI(authKey!)}`,
        );
      } catch (err: unknown) {
        // 404 = not configured yet; treat as null so the UI can render
        // the registration form.
        if (
          err &&
          typeof err === "object" &&
          "status" in err &&
          (err as { status: number }).status === 404
        ) {
          return null;
        }
        throw err;
      }
    },
  });
}

export function useUpsertIntegrationOAuthClient() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useMutation({
    mutationFn: ({
      packageId,
      authKey,
      clientId,
      clientSecret,
      redirectUri,
    }: {
      packageId: string;
      authKey: string;
      clientId: string;
      clientSecret: string;
      redirectUri?: string;
    }) =>
      api<IntegrationOAuthClient>(
        `/integrations/${encodeURI(packageId)}/oauth-clients/${encodeURI(authKey)}`,
        {
          method: "PUT",
          body: JSON.stringify({
            clientId,
            clientSecret,
            ...(redirectUri ? { redirectUri } : {}),
          }),
        },
      ),
    onSuccess: (_data, vars) => {
      toast.success(t("integration.oauthClient.save.success"));
      qc.invalidateQueries({
        queryKey: [...KEY(orgId, applicationId), "oauth-client", vars.packageId, vars.authKey],
      });
      qc.invalidateQueries({
        queryKey: [...KEY(orgId, applicationId), "detail", vars.packageId],
      });
    },
  });
}

// ─────────────────────────────────────────────
// Admin: block_user_connections + pins + connection metadata
// ─────────────────────────────────────────────

export interface IntegrationPin {
  packageId: string;
  integrationPackageId: string;
  authKey: string;
  connectionId: string;
  createdAt: string;
  updatedAt: string;
}

export function useIntegrationPins(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: [...KEY(orgId, applicationId), "pins", packageId] as const,
    queryFn: () => apiList<IntegrationPin>(`/integrations/${encodeURI(packageId!)}/pins`),
    enabled: !!packageId && !!orgId && !!applicationId,
  });
}

export function useUpdateIntegrationSettings() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useMutation({
    mutationFn: ({
      packageId,
      blockUserConnections,
    }: {
      packageId: string;
      blockUserConnections: boolean;
    }) =>
      api<{ blocked: boolean }>(`/integrations/${encodeURI(packageId)}/settings`, {
        method: "PATCH",
        body: JSON.stringify({ blockUserConnections }),
        headers: { "Content-Type": "application/json" },
      }),
    onSuccess: (_data, vars) => {
      toast.success(t("integration.admin.blockUserConnections.updated"));
      qc.invalidateQueries({
        queryKey: [...KEY(orgId, applicationId), "detail", vars.packageId],
      });
    },
  });
}

export function useUpsertIntegrationPin() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useMutation({
    mutationFn: ({
      packageId,
      agentPackageId,
      authKey,
      connectionId,
    }: {
      packageId: string;
      agentPackageId: string;
      authKey: string;
      connectionId: string;
    }) =>
      api<IntegrationPin>(
        `/integrations/${encodeURI(packageId)}/pins/${encodeURI(agentPackageId)}/${encodeURI(authKey)}`,
        {
          method: "PUT",
          body: JSON.stringify({ connectionId }),
          headers: { "Content-Type": "application/json" },
        },
      ),
    onSuccess: (_data, vars) => {
      toast.success(t("integration.admin.pin.upserted"));
      qc.invalidateQueries({
        queryKey: [...KEY(orgId, applicationId), "pins", vars.packageId],
      });
    },
  });
}

export function useDeleteIntegrationPin() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useMutation({
    mutationFn: ({
      packageId,
      agentPackageId,
      authKey,
    }: {
      packageId: string;
      agentPackageId: string;
      authKey: string;
    }) =>
      api<{ deleted: boolean }>(
        `/integrations/${encodeURI(packageId)}/pins/${encodeURI(agentPackageId)}/${encodeURI(authKey)}`,
        { method: "DELETE" },
      ),
    onSuccess: (_data, vars) => {
      toast.success(t("integration.admin.pin.deleted"));
      qc.invalidateQueries({
        queryKey: [...KEY(orgId, applicationId), "pins", vars.packageId],
      });
    },
  });
}

export function useUpdateIntegrationConnection() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useMutation({
    mutationFn: ({
      packageId,
      connectionId,
      label,
      sharedWithOrg,
    }: {
      packageId: string;
      connectionId: string;
      label?: string | null;
      sharedWithOrg?: boolean;
    }) =>
      api<{ id: string; label: string | null; sharedWithOrg: boolean; updatedAt: string }>(
        `/integrations/${encodeURI(packageId)}/connections/${connectionId}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            ...(label !== undefined ? { label } : {}),
            ...(sharedWithOrg !== undefined ? { sharedWithOrg } : {}),
          }),
          headers: { "Content-Type": "application/json" },
        },
      ),
    onSuccess: (_data, vars) => {
      toast.success(t("integration.connection.updated"));
      qc.invalidateQueries({
        queryKey: [...KEY(orgId, applicationId), "connections", vars.packageId],
      });
      qc.invalidateQueries({
        queryKey: [...KEY(orgId, applicationId), "detail", vars.packageId],
      });
    },
  });
}

export function useDeleteIntegrationOAuthClient() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useMutation({
    mutationFn: ({ packageId, authKey }: { packageId: string; authKey: string }) =>
      api<{ deleted: boolean }>(
        `/integrations/${encodeURI(packageId)}/oauth-clients/${encodeURI(authKey)}`,
        { method: "DELETE" },
      ),
    onSuccess: (_data, vars) => {
      toast.success(t("integration.oauthClient.delete.success"));
      qc.invalidateQueries({
        queryKey: [...KEY(orgId, applicationId), "oauth-client", vars.packageId, vars.authKey],
      });
      qc.invalidateQueries({
        queryKey: [...KEY(orgId, applicationId), "detail", vars.packageId],
      });
    },
  });
}
