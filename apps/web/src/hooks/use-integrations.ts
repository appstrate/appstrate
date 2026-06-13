// SPDX-License-Identifier: Apache-2.0

/**
 * React Query hooks for the AFPS integration marketplace (Phase 1.3).
 *
 * Hooks backed by `/api/integrations/*` through the typed OpenAPI client.
 * Query keys are the openapi-react-query `[method, path, init]` triples; the
 * spec-declared `X-Org-Id`/`X-Application-Id` headers ride in `init` so the
 * keys stay org/app-scoped — switching org or application refetches instead
 * of serving another scope's cached page.
 */

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
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
import { $api, client, ApiError } from "../api/client";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import { useOrgScope } from "./use-org-scope";

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
// Typed-client plumbing
// ─────────────────────────────────────────────
// Scoped package ids (`@scope/name`) in path params keep their raw `@` and
// `/` on the wire — handled globally by the client's pathSerializer.

/**
 * Invalidate every cached integrations read (list, detail, connections,
 * pins, org default, agent resolutions, OAuth clients). Typed keys are
 * `[method, "/api/integrations…", init]` — a key-prefix invalidation can't
 * span sibling path strings, so match on the path element instead.
 */
export function invalidateIntegrationQueries(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({
    predicate: (query) => {
      const path = query.queryKey[1];
      return typeof path === "string" && path.startsWith("/api/integrations");
    },
  });
}

// ─────────────────────────────────────────────
// Hooks
// ─────────────────────────────────────────────

export function useIntegrations() {
  const scope = useOrgScope();
  return $api.useQuery(
    "get",
    "/api/integrations",
    { params: { header: scope.header } },
    {
      enabled: scope.enabled,
      // The spec types `manifest` as an open JSON object (AFPS manifests are
      // dynamic); the shared wire types narrow it to IntegrationManifestView.
      // Same trust boundary the legacy `api<IntegrationSummary>` cast drew.
      select: (envelope) => envelope.data as IntegrationSummary[],
    },
  );
}

export function useIntegrationDetail(packageId: string | undefined) {
  const scope = useOrgScope();
  return $api.useQuery(
    "get",
    "/api/integrations/{packageId}",
    {
      params: { path: { packageId: packageId ?? "" }, header: scope.header },
    },
    {
      enabled: scope.enabled && !!packageId,
      // Spec `manifest` is an open JSON object — see useIntegrations.
      select: (data) => data as IntegrationDetail,
    },
  );
}

export function useIntegrationConnections(packageId: string | undefined) {
  const scope = useOrgScope();
  return $api.useQuery(
    "get",
    "/api/integrations/{packageId}/connections",
    {
      params: { path: { packageId: packageId ?? "" }, header: scope.header },
    },
    {
      enabled: scope.enabled && !!packageId,
      select: (envelope): IntegrationConnection[] => envelope.data,
    },
  );
}

/**
 * Shared query options for a (integration, agent) resolution verdict.
 * Exported so every consumer — the picker hook
 * ({@link useIntegrationAgentResolution}) and the launch-badge readiness hook
 * (`useAgentIntegrationsReadiness`) — builds the SAME `[method, path, init]`
 * key from ONE place and shares the cache. Hand-copying the key risked a
 * silent cache split where the badge and the Connexions tab fetch the same
 * verdict twice and disagree.
 */
export function agentResolutionQueryOptions(
  orgId: string | null | undefined,
  applicationId: string | null | undefined,
  integrationId: string | undefined,
  agentPackageId: string | undefined,
) {
  return $api.queryOptions(
    "get",
    "/api/integrations/{packageId}/agent-resolution/{agentPackageId}",
    {
      params: {
        path: { packageId: integrationId ?? "", agentPackageId: agentPackageId ?? "" },
        header: {
          "X-Org-Id": orgId ?? undefined,
          "X-Application-Id": applicationId ?? undefined,
        },
      },
    },
    {
      enabled: Boolean(orgId && applicationId && integrationId && agentPackageId),
      // The spec marks the org-default fields optional; the shared wire type
      // is the backend resolver's source of truth (always present). Same
      // assertion the legacy `api<IntegrationAgentResolution>` call made.
      select: (data) => data as IntegrationAgentResolution,
    },
  );
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
  return useQuery(agentResolutionQueryOptions(orgId, applicationId, integrationId, agentPackageId));
}

export function useActivateIntegration() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  return useMutation({
    // 201 + the bare integration detail resource (#657) — activation
    // state is the resource's `active` field.
    mutationFn: async (vars: { params: { path: { packageId: string } } }) => {
      const { data } = await client.POST("/api/integrations/{packageId}/activate", {
        ...vars,
        body: {},
      });
      return data;
    },
    onSuccess: () => {
      toast.success(t("integrations.activate.success"));
      void invalidateIntegrationQueries(qc);
    },
    onError: () => toast.error(t("integrations.activate.error")),
  });
}

export function useDeactivateIntegration() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  return useMutation({
    // DELETE → 204 empty (#657): deactivation removes the
    // application_packages row; the detail stays GET-able.
    mutationFn: async (vars: { params: { path: { packageId: string } } }) => {
      await client.DELETE("/api/integrations/{packageId}/deactivate", {
        ...vars,
      });
    },
    onSuccess: () => {
      toast.success(t("integrations.deactivate.success"));
      void invalidateIntegrationQueries(qc);
    },
    onError: () => toast.error(t("integrations.deactivate.error")),
  });
}

export function useConnectIntegrationFields() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      params: { path: { packageId: string; authKey: string } };
      body: { credentials: Record<string, string>; connection_id?: string };
    }) => {
      const { data } = await client.POST(
        "/api/integrations/{packageId}/auths/{authKey}/connect/fields",
        vars,
      );
      // Non-2xx throws in the client middleware, so a missing body on a 200
      // is a broken server contract — surface it instead of returning undefined.
      if (!data) throw new Error("empty response");
      return data;
    },
    onSuccess: () => {
      toast.success(t("integration.connect.success"));
      void invalidateIntegrationQueries(qc);
      // Cross-app connections page (/preferences/connections) — keep parity with
      // the OAuth popup path so a fields connect/renew refreshes that list too.
      void qc.invalidateQueries({ queryKey: ["get", "/api/me/connections"] });
    },
    onError: () => toast.error(t("integration.connect.error")),
  });
}

export function useInitiateIntegrationOAuth() {
  const { t } = useTranslation("settings");
  return useMutation({
    mutationFn: async (vars: {
      params: { path: { packageId: string; authKey: string } };
      body: { scopes?: string[]; force_account_select?: boolean; connection_id?: string };
    }) => {
      const { data } = await client.POST(
        "/api/integrations/{packageId}/auths/{authKey}/connect/oauth2",
        vars,
      );
      if (!data) throw new Error("empty response");
      return data;
    },
    onError: () => toast.error(t("integration.connect.error")),
  });
}

export function useIntegrationOAuthClient(
  packageId: string | undefined,
  authKey: string | undefined,
) {
  const scope = useOrgScope();
  return useQuery({
    // Same [method, path, init] shape as the $api hooks so the path-string
    // invalidations below hit this query too.
    queryKey: [
      "get",
      "/api/integrations/{packageId}/oauth-clients/{authKey}",
      { params: { path: { packageId, authKey }, header: scope.header } },
    ] as const,
    enabled: scope.enabled && !!packageId && !!authKey,
    queryFn: async (): Promise<IntegrationOAuthClient | null> => {
      try {
        const { data } = await client.GET("/api/integrations/{packageId}/oauth-clients/{authKey}", {
          params: { path: { packageId: packageId!, authKey: authKey! }, header: scope.header },
        });
        return data ?? null;
      } catch (err: unknown) {
        // 404 = not configured yet; treat as null so the UI can render
        // the registration form.
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
  });
}

export function useUpsertIntegrationOAuthClient() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      params: { path: { packageId: string; authKey: string } };
      body: { client_id: string; client_secret: string; redirect_uri?: string };
    }) => {
      const { data } = await client.PUT("/api/integrations/{packageId}/oauth-clients/{authKey}", {
        ...vars,
      });
      return data;
    },
    onSuccess: () => {
      toast.success(t("integration.oauthClient.save.success"));
      void qc.invalidateQueries({
        queryKey: ["get", "/api/integrations/{packageId}/oauth-clients/{authKey}"],
      });
      void qc.invalidateQueries({ queryKey: ["get", "/api/integrations/{packageId}"] });
    },
  });
}

// ─────────────────────────────────────────────
// Admin: block_user_connections + pins + connection metadata
// ─────────────────────────────────────────────

export function useIntegrationPins(packageId: string | undefined) {
  const scope = useOrgScope();
  return $api.useQuery(
    "get",
    "/api/integrations/{packageId}/pins",
    {
      params: { path: { packageId: packageId ?? "" }, header: scope.header },
    },
    {
      enabled: scope.enabled && !!packageId,
      select: (envelope): IntegrationPin[] => envelope.data,
    },
  );
}

/**
 * R2 — installed agents that declare this integration as a dependency. Used
 * by the centralised pin management table to populate the "pin a new agent"
 * picker.
 */
export function useAgentsConsumingIntegration(packageId: string | undefined) {
  const scope = useOrgScope();
  return $api.useQuery(
    "get",
    "/api/integrations/{packageId}/consuming-agents",
    {
      params: { path: { packageId: packageId ?? "" }, header: scope.header },
    },
    {
      enabled: scope.enabled && !!packageId,
      select: (envelope): ConsumingAgentSummary[] => envelope.data,
    },
  );
}

export function useUpdateIntegrationSettings() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  return useMutation({
    // 200 + the bare integration detail resource (#657) — the toggled
    // gate is the resource's `block_user_connections` field.
    mutationFn: async (vars: {
      params: { path: { packageId: string } };
      body: { block_user_connections: boolean };
    }) => {
      const { data } = await client.PATCH("/api/integrations/{packageId}/settings", {
        ...vars,
      });
      return data;
    },
    onSuccess: () => {
      toast.success(t("integration.admin.blockUserConnections.updated"));
      void qc.invalidateQueries({ queryKey: ["get", "/api/integrations/{packageId}"] });
    },
  });
}

export function useUpsertIntegrationPin() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      params: { path: { packageId: string; agentPackageId: string } };
      body: { connection_id: string };
    }) => {
      const { data } = await client.PUT("/api/integrations/{packageId}/pins/{agentPackageId}", {
        ...vars,
      });
      return data;
    },
    onSuccess: () => {
      toast.success(t("integration.admin.pin.upserted"));
      void qc.invalidateQueries({ queryKey: ["get", "/api/integrations/{packageId}/pins"] });
    },
  });
}

export function useDeleteIntegrationPin() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      params: { path: { packageId: string; agentPackageId: string } };
    }) => {
      await client.DELETE("/api/integrations/{packageId}/pins/{agentPackageId}", {
        ...vars,
      });
    },
    onSuccess: () => {
      toast.success(t("integration.admin.pin.deleted"));
      void qc.invalidateQueries({ queryKey: ["get", "/api/integrations/{packageId}/pins"] });
    },
  });
}

// ─── Org default connection (cross-agent governance) ───────────────────────

export function useIntegrationOrgDefault(packageId: string | undefined) {
  const scope = useOrgScope();
  return $api.useQuery(
    "get",
    "/api/integrations/{packageId}/default",
    {
      params: { path: { packageId: packageId ?? "" }, header: scope.header },
    },
    {
      enabled: scope.enabled && !!packageId,
      // Bare resource, or a 204 when no default is set — openapi-react-query
      // maps the empty body to null for the existing null-means-unset consumers.
      select: (data): IntegrationOrgDefault | null => data ?? null,
    },
  );
}

export function useUpsertIntegrationOrgDefault() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      params: { path: { packageId: string } };
      body: { connection_id: string; enforce: boolean };
    }) => {
      const { data } = await client.PUT("/api/integrations/{packageId}/default", {
        ...vars,
      });
      return data;
    },
    onSuccess: () => {
      toast.success(t("integration.admin.orgDefault.updated"));
      // Picker verdicts on agent pages depend on the org default —
      // invalidate every integrations read, not just the default itself.
      void invalidateIntegrationQueries(qc);
    },
  });
}

export function useDeleteIntegrationOrgDefault() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { params: { path: { packageId: string } } }) => {
      await client.DELETE("/api/integrations/{packageId}/default", {
        ...vars,
      });
    },
    onSuccess: () => {
      toast.success(t("integration.admin.orgDefault.deleted"));
      void invalidateIntegrationQueries(qc);
    },
  });
}

export function useUpdateIntegrationConnection() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  return useMutation({
    // 200 + the bare connection resource (#657) — same serializer as the
    // connections list.
    mutationFn: async (vars: {
      params: { path: { packageId: string; connectionId: string } };
      body: { label?: string | null; shared_with_org?: boolean };
    }) => {
      const { data } = await client.PATCH(
        "/api/integrations/{packageId}/connections/{connectionId}",
        vars,
      );
      return data;
    },
    onSuccess: () => {
      toast.success(t("integration.connection.updated"));
      void qc.invalidateQueries({
        queryKey: ["get", "/api/integrations/{packageId}/connections"],
      });
      void qc.invalidateQueries({ queryKey: ["get", "/api/integrations/{packageId}"] });
    },
  });
}

export function useDeleteIntegrationOAuthClient() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { params: { path: { packageId: string; authKey: string } } }) => {
      await client.DELETE("/api/integrations/{packageId}/oauth-clients/{authKey}", {
        ...vars,
      });
    },
    onSuccess: () => {
      toast.success(t("integration.oauthClient.delete.success"));
      void qc.invalidateQueries({
        queryKey: ["get", "/api/integrations/{packageId}/oauth-clients/{authKey}"],
      });
      void qc.invalidateQueries({ queryKey: ["get", "/api/integrations/{packageId}"] });
    },
  });
}
