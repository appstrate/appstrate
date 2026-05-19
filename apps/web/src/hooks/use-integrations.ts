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
import { api, apiList, type ListEnvelope } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";

// ─────────────────────────────────────────────
// Types (mirror the backend OpenAPI shapes)
// ─────────────────────────────────────────────

export interface IntegrationSummary {
  id: string;
  manifest: IntegrationManifestView;
  orgId: string | null;
  source: "local" | "system";
  installed?: boolean;
}

export interface IntegrationManifestView {
  name: string;
  version: string;
  displayName: string;
  description?: string;
  license?: string;
  author?: string | { name: string; email?: string; url?: string };
  repository?: string | { type: string; url: string };
  privacyPolicy?: string;
  keywords?: string[];
  icon?: string;
  compatibility?: { afps?: string; mcp?: string };
  server: {
    type: string;
    entryPoint?: string;
    url?: string;
    toolsDynamic?: boolean;
  };
  transport?: { type: "stdio" | "streamable-http" | "sse" };
  auths?: Record<string, IntegrationManifestAuth>;
  /**
   * Niveau 2 (Phase 0) — per-tool scope + URL pattern metadata. Optional;
   * integrations that omit this block keep legacy "all tools allowed"
   * semantics. The agent editor reads this to render the tool picker.
   */
  tools?: Record<string, IntegrationManifestTool>;
}

export interface IntegrationManifestTool {
  requiredScopes?: string[];
  requiredAuthKey?: string;
  urlPatterns?: Array<{ pattern: string; methods?: string[] }>;
}

export interface IntegrationManifestAuth {
  type: "oauth2" | "oauth1" | "api_key" | "basic" | "custom";
  required?: boolean;
  authorizationUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
  audience?: string;
  authorizedUris: string[];
  credentials?: {
    schema: Record<string, unknown>;
  };
  tokenAuthMethod?: "client_secret_post" | "client_secret_basic" | "none";
  delivery: Record<string, unknown>;
  /**
   * Niveau 2 (Phase 0) — IdP-side scope catalog. Optional; when set, the
   * UI uses {value, label, description?} to render human-readable scope
   * pickers instead of raw scope strings. Defaults `scopes[]` and agent
   * `requiredScopes` must be subsets of this catalog.
   */
  availableScopes?: Array<{ value: string; label: string; description?: string }>;
}

export interface IntegrationConnection {
  id: string;
  packageId: string;
  authKey: string;
  accountId: string;
  identityClaims: Record<string, unknown> | null;
  scopesGranted: string[];
  needsReconnection: boolean;
  expiresAt: string | null;
  ownerType: "user" | "end_user";
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationAuthStatus {
  authKey: string;
  type: IntegrationManifestAuth["type"];
  required: boolean;
  scopes: string[];
  audience: string | null;
  connections: IntegrationConnection[];
  hasOAuthClient: boolean;
}

export interface IntegrationDetail {
  manifest: IntegrationManifestView;
  auths: IntegrationAuthStatus[];
}

/**
 * Niveau 2 Phase 5 — wire shape for
 * `GET /api/integrations/:packageId/auths/:authKey/required-scopes`.
 *
 *  - `defaults` — manifest defaults for this auth.
 *  - `required` — union of `requiredScopes` across every installed agent
 *    that depends on this integration (filtered by `requiredAuthKey` for
 *    multi-auth integrations).
 *  - `granted` — actor's current high-water-mark across all their
 *    connections on this integration auth.
 *  - `union` — `defaults ∪ required ∪ granted` — what the OAuth kickoff
 *    will actually request (incremental consent).
 *  - `missingFromGranted` — scopes that the union demands but the actor
 *    hasn't granted yet → drives the "Reconnect to grant new
 *    permissions" CTA.
 *  - `breakdown` — per-agent decomposition for the audit / "why is this
 *    permission required?" surface.
 */
export interface IntegrationRequiredScopes {
  defaults: string[];
  required: string[];
  granted: string[];
  union: string[];
  missingFromGranted: string[];
  breakdown: Array<{
    agentId: string;
    viaTools: string[];
    viaExplicit: string[];
  }>;
}

export interface IntegrationOAuthClient {
  applicationId: string;
  integrationPackageId: string;
  authKey: string;
  clientId: string;
  hasClientSecret: boolean;
  redirectUri: string | null;
  createdAt: string;
  updatedAt: string;
}

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
