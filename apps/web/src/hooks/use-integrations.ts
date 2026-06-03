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
  ConsumingAgentSummary,
  IntegrationAgentResolution,
  IntegrationConnection,
  IntegrationDetail,
  IntegrationOAuthClient,
  IntegrationOrgDefault,
  IntegrationPin,
  IntegrationSummary,
} from "@appstrate/shared-types";
import { api, apiList, type ListEnvelope } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";

// Re-export wire types for component consumers — canonical definitions
// live in `@appstrate/shared-types/integrations.ts`.
export type {
  AgentIntegrationEntry,
  IntegrationAgentResolution,
  IntegrationAuthStatus,
  IntegrationAuthType,
  IntegrationCandidate,
  IntegrationConnection,
  IntegrationDetail,
  IntegrationManifestAuth,
  IntegrationManifestView,
  IntegrationSummary,
} from "@appstrate/shared-types";

// ─────────────────────────────────────────────
// Hooks
// ─────────────────────────────────────────────

const KEY = (orgId: string | null | undefined, applicationId: string | null | undefined) =>
  ["integrations", orgId ?? undefined, applicationId ?? undefined] as const;

/**
 * Shared request builder for `PATCH /integrations/{packageId}/connections/{id}`.
 *
 * Both the agent-context update (`useUpdateIntegrationConnection`) and the
 * user-scope update (`useUpdateMeIntegrationConnection`) PATCH the same
 * endpoint with the same conditional `{ label?, sharedWithOrg? }` body. They
 * differ only in extra headers (the user-scope variant pins org/app) and which
 * React Query keys they invalidate — both of which stay in the calling hook.
 * The caller passes the result straight to `api<T>(path, init)`, keeping its
 * own response type.
 */
export function buildUpdateConnectionRequest(args: {
  packageId: string;
  connectionId: string;
  label?: string | null;
  sharedWithOrg?: boolean;
  extraHeaders?: Record<string, string>;
}): [string, RequestInit] {
  const { packageId, connectionId, label, sharedWithOrg, extraHeaders } = args;
  return [
    `/integrations/${encodeURI(packageId)}/connections/${connectionId}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        ...(label !== undefined ? { label } : {}),
        ...(sharedWithOrg !== undefined ? { shared_with_org: sharedWithOrg } : {}),
      }),
      headers: {
        "Content-Type": "application/json",
        ...extraHeaders,
      },
    },
  ];
}

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
 * Server-side picker verdict for a (agent, integration) on the agent page:
 * which connection the next run resolves to + the annotated candidate list
 * + pin/blocked state. The dropdown renders this verbatim — the resolver
 * cascade and scope diff live server-side (single source of truth).
 */
export function useIntegrationAgentResolution(
  integrationId: string | undefined,
  agentPackageId: string | undefined,
) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: [
      ...KEY(orgId, applicationId),
      "agent-resolution",
      integrationId,
      agentPackageId,
    ] as const,
    enabled: Boolean(orgId && applicationId && integrationId && agentPackageId),
    queryFn: () =>
      api<IntegrationAgentResolution>(
        `/integrations/${encodeURI(integrationId!)}/agent-resolution/${encodeURI(agentPackageId!)}`,
      ),
  });
}

export function useActivateIntegration() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useMutation({
    mutationFn: (packageId: string) =>
      api<{ active: boolean; activated_at: string }>(
        `/integrations/${encodeURI(packageId)}/activate`,
        { method: "POST", body: "{}" },
      ),
    onSuccess: () => {
      toast.success(t("integrations.activate.success"));
      qc.invalidateQueries({ queryKey: KEY(orgId, applicationId) });
    },
    onError: () => toast.error(t("integrations.activate.error")),
  });
}

export function useDeactivateIntegration() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useMutation({
    mutationFn: (packageId: string) =>
      api<{ active: boolean }>(`/integrations/${encodeURI(packageId)}/deactivate`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success(t("integrations.deactivate.success"));
      qc.invalidateQueries({ queryKey: KEY(orgId, applicationId) });
    },
    onError: () => toast.error(t("integrations.deactivate.error")),
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
      connectionId,
    }: {
      packageId: string;
      authKey: string;
      credentials: Record<string, string>;
      connectionId?: string;
    }) =>
      api<IntegrationConnection>(
        `/integrations/${encodeURI(packageId)}/auths/${encodeURI(authKey)}/connect/fields`,
        {
          method: "POST",
          body: JSON.stringify({
            credentials,
            ...(connectionId ? { connection_id: connectionId } : {}),
          }),
        },
      ),
    onSuccess: (_data, vars) => {
      toast.success(t("integration.connect.success"));
      qc.invalidateQueries({ queryKey: KEY(orgId, applicationId) });
      qc.invalidateQueries({
        queryKey: [...KEY(orgId, applicationId), "detail", vars.packageId],
      });
      // Cross-app connections page (/preferences/connections) — keep parity with
      // the OAuth popup path so a fields connect/renew refreshes that list too.
      qc.invalidateQueries({ queryKey: ["me-connections"] });
    },
    onError: () => toast.error(t("integration.connect.error")),
  });
}

export function useInitiateIntegrationOAuth() {
  const { t } = useTranslation("settings");
  return useMutation({
    mutationFn: ({
      packageId,
      authKey,
      scopes,
      forceAccountSelect,
      connectionId,
    }: {
      packageId: string;
      authKey: string;
      scopes?: string[];
      forceAccountSelect?: boolean;
      connectionId?: string;
    }) =>
      api<{ auth_url: string; state: string }>(
        `/integrations/${encodeURI(packageId)}/auths/${encodeURI(authKey)}/connect/oauth2`,
        {
          method: "POST",
          body: JSON.stringify({
            scopes: scopes ?? [],
            ...(forceAccountSelect ? { force_account_select: true } : {}),
            ...(connectionId ? { connection_id: connectionId } : {}),
          }),
        },
      ),
    onError: () => toast.error(t("integration.connect.error")),
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
            client_id: clientId,
            client_secret: clientSecret,
            ...(redirectUri ? { redirect_uri: redirectUri } : {}),
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

export function useIntegrationPins(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: [...KEY(orgId, applicationId), "pins", packageId] as const,
    queryFn: () => apiList<IntegrationPin>(`/integrations/${encodeURI(packageId!)}/pins`),
    enabled: !!packageId && !!orgId && !!applicationId,
  });
}

/**
 * R2 — installed agents that declare this integration as a dependency. Used
 * by the centralised pin management table to populate the "pin a new agent"
 * picker.
 */
export function useAgentsConsumingIntegration(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: [...KEY(orgId, applicationId), "consuming-agents", packageId] as const,
    queryFn: () =>
      apiList<ConsumingAgentSummary>(`/integrations/${encodeURI(packageId!)}/consuming-agents`),
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
        body: JSON.stringify({ block_user_connections: blockUserConnections }),
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
      connectionId,
    }: {
      packageId: string;
      agentPackageId: string;
      connectionId: string;
    }) =>
      api<IntegrationPin>(
        `/integrations/${encodeURI(packageId)}/pins/${encodeURI(agentPackageId)}`,
        {
          method: "PUT",
          body: JSON.stringify({ connection_id: connectionId }),
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
    mutationFn: ({ packageId, agentPackageId }: { packageId: string; agentPackageId: string }) =>
      api<{ deleted: boolean }>(
        `/integrations/${encodeURI(packageId)}/pins/${encodeURI(agentPackageId)}`,
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

// ─── Org default connection (cross-agent governance) ───────────────────────

export function useIntegrationOrgDefault(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: [...KEY(orgId, applicationId), "org-default", packageId] as const,
    queryFn: () =>
      api<{ default: IntegrationOrgDefault | null }>(
        `/integrations/${encodeURI(packageId!)}/default`,
      ).then((r) => r.default),
    enabled: !!packageId && !!orgId && !!applicationId,
  });
}

export function useUpsertIntegrationOrgDefault() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useMutation({
    mutationFn: ({
      packageId,
      connectionId,
      enforce,
    }: {
      packageId: string;
      connectionId: string;
      enforce: boolean;
    }) =>
      api<IntegrationOrgDefault>(`/integrations/${encodeURI(packageId)}/default`, {
        method: "PUT",
        body: JSON.stringify({ connection_id: connectionId, enforce }),
        headers: { "Content-Type": "application/json" },
      }),
    onSuccess: (_data, vars) => {
      toast.success(t("integration.admin.orgDefault.updated"));
      qc.invalidateQueries({
        queryKey: [...KEY(orgId, applicationId), "org-default", vars.packageId],
      });
      // Picker verdicts on agent pages depend on the org default.
      qc.invalidateQueries({ queryKey: ["integrations"] });
    },
  });
}

export function useDeleteIntegrationOrgDefault() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useMutation({
    mutationFn: ({ packageId }: { packageId: string }) =>
      api<{ deleted: boolean }>(`/integrations/${encodeURI(packageId)}/default`, {
        method: "DELETE",
      }),
    onSuccess: (_data, vars) => {
      toast.success(t("integration.admin.orgDefault.deleted"));
      qc.invalidateQueries({
        queryKey: [...KEY(orgId, applicationId), "org-default", vars.packageId],
      });
      qc.invalidateQueries({ queryKey: ["integrations"] });
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
      api<{ id: string; label: string | null; shared_with_org: boolean; updatedAt: string }>(
        ...buildUpdateConnectionRequest({ packageId, connectionId, label, sharedWithOrg }),
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
