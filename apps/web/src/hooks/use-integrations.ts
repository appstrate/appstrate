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
  IntegrationConnection,
  IntegrationManifestView,
  IntegrationOrgDefault,
  IntegrationPin,
} from "@appstrate/shared-types";
import { $api, client, type paths } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { isVersioned } from "../lib/version-selector";

// Spec-pinned narrowings for the two integration read endpoints. They take the
// generated OpenAPI response shape verbatim (so a rename/removal of any
// non-`manifest` field breaks compilation) and narrow only the freeform AFPS
// `manifest` JSON to IntegrationManifestView — the single trust boundary the
// legacy `api<IntegrationSummary>()` cast drew. This replaces a blind
// `as IntegrationSummary[]` that erased the spec type and could hide drift on
// every non-manifest field.
type RawIntegrationSummary = NonNullable<
  paths["/api/integrations"]["get"]["responses"]["200"]["content"]["application/json"]["data"]
>[number];
export type IntegrationSummaryWire = Omit<RawIntegrationSummary, "manifest"> &
  // `/api/integrations` supports `?fields=` projection, so the spec marks these
  // optional; this hook never projects, so re-require what consumers read.
  Required<Pick<RawIntegrationSummary, "id" | "orgId" | "source">> & {
    manifest: IntegrationManifestView;
  };
type RawIntegrationDetail =
  paths["/api/integrations/{packageId}"]["get"]["responses"]["200"]["content"]["application/json"];
export type IntegrationDetailWire = Omit<RawIntegrationDetail, "manifest"> & {
  manifest: IntegrationManifestView;
};
/**
 * One OAuth client offered for connecting an integration auth — the org's
 * custom (BYO-app) client or a platform-provided system client. Spec-derived so
 * a rename/removal of any wire field breaks compilation. Secrets never present.
 */
export type IntegrationClient = NonNullable<
  paths["/api/integrations/{packageId}/auths/{authKey}/clients"]["get"]["responses"]["200"]["content"]["application/json"]["data"]
>[number];
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import { useOrgScope } from "./use-org-scope";

// Re-export wire types for component consumers — canonical definitions
// live in `@appstrate/shared-types/integrations.ts`.
// NB: the integration list/detail READ shapes are NOT re-exported from
// shared-types — consumers must use the spec-derived IntegrationSummaryWire /
// IntegrationDetailWire (above), the exact shape the hooks return, so a spec
// rename/removal of any non-`manifest` field breaks compilation.
export type {
  AgentIntegrationEntry,
  IntegrationAgentResolution,
  IntegrationAuthStatus,
  IntegrationAuthType,
  IntegrationCandidate,
  IntegrationConnection,
  IntegrationManifestAuth,
  IntegrationManifestView,
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
      return (
        typeof path === "string" &&
        // The per-agent connection-readiness query lives under /api/agents but
        // is driven entirely by connection state, so refresh it here too.
        (path.startsWith("/api/integrations") ||
          path === "/api/agents/{scope}/{name}/connection-readiness")
      );
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
      // Spec-pinned (see IntegrationSummaryWire): only `manifest` is narrowed.
      select: (envelope) => envelope.data as IntegrationSummaryWire[],
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
      // Spec-pinned (see IntegrationDetailWire): only `manifest` is narrowed.
      select: (data) => data as IntegrationDetailWire,
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
export function agentConnectionReadinessQueryOptions(
  orgId: string | null | undefined,
  applicationId: string | null | undefined,
  agentPackageId: string | undefined,
  version?: string,
) {
  const { scope, name } = agentPackageId
    ? splitPackageRef(agentPackageId)
    : { scope: "", name: "" };
  // A non-`draft` version pins the verdict to that published manifest, so the
  // run-options modal's per-integration badge matches the run (#770). Omitted/
  // `draft` → no query param → the draft verdict the launch badge has always
  // shown. `version` rides the query so the cache key splits per version.
  return $api.queryOptions(
    "get",
    "/api/agents/{scope}/{name}/connection-readiness",
    {
      params: {
        path: { scope, name },
        ...(isVersioned(version) ? { query: { version } } : {}),
        header: {
          "X-Org-Id": orgId ?? undefined,
          "X-Application-Id": applicationId ?? undefined,
        },
      },
    },
    { enabled: Boolean(orgId && applicationId && agentPackageId) },
  );
}

/**
 * Bulk connection readiness for an agent — ONE call that drives the launch
 * badge, the Connexions tab pickers, and the pre-run check. `blocks_run` /
 * `errors` mirror the run-kickoff 412 (run semantics); `integrations[]` carries
 * every declared integration's management verdict (includeInert) + a
 * `run_blocking` flag. Replaces the former N per-integration round-trips.
 */
export function useAgentConnectionReadiness(agentPackageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery(agentConnectionReadinessQueryOptions(orgId, applicationId, agentPackageId));
}

/**
 * Server-side picker verdict for a (agent, integration) on the agent page:
 * which connection the next run resolves to + the annotated candidate list
 * + pin/blocked state. Selected out of the single bulk readiness query so the
 * picker, badge, and modal all share one cache entry per agent.
 */
export function useIntegrationAgentResolution(
  integrationId: string | undefined,
  agentPackageId: string | undefined,
  version?: string,
) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    ...agentConnectionReadinessQueryOptions(orgId, applicationId, agentPackageId, version),
    enabled: Boolean(orgId && applicationId && integrationId && agentPackageId),
    select: (data) =>
      data.integrations.find((i) => i.integration_id === integrationId)?.resolution ?? null,
  });
}

/**
 * Whether a given integration would block the next run (run semantics — inert
 * optional integrations are NOT blocking, inert required ones ARE). Selected
 * from the same bulk readiness query the picker uses.
 */
export function useIntegrationRunBlocking(
  integrationId: string | undefined,
  agentPackageId: string | undefined,
  version?: string,
) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    ...agentConnectionReadinessQueryOptions(orgId, applicationId, agentPackageId, version),
    enabled: Boolean(orgId && applicationId && integrationId && agentPackageId),
    select: (data) =>
      data.integrations.find((i) => i.integration_id === integrationId)?.run_blocking ?? false,
  });
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
      body: {
        scopes?: string[];
        force_account_select?: boolean;
        connection_id?: string;
      };
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

/** Invalidate the clients list + detail after a client mutation. */
function useInvalidateIntegrationClients() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({
      queryKey: ["get", "/api/integrations/{packageId}/auths/{authKey}/clients"],
    });
    void qc.invalidateQueries({ queryKey: ["get", "/api/integrations/{packageId}"] });
  };
}

/**
 * Register a NEW custom (BYO-app) OAuth client for an auth — repeatable, so an
 * org can hold N clients. The first becomes the default; later ones stay
 * non-default until promoted via {@link useSetDefaultIntegrationClient}.
 */
export function useCreateIntegrationOAuthClient() {
  const { t } = useTranslation("settings");
  const invalidate = useInvalidateIntegrationClients();
  return $api.useMutation("post", "/api/integrations/{packageId}/auths/{authKey}/oauth-clients", {
    onSuccess: () => {
      toast.success(t("integration.oauthClient.save.success"));
      invalidate();
    },
  });
}

/** Rotate one custom client's credentials in place, by its id. */
export function useRotateIntegrationOAuthClient() {
  const { t } = useTranslation("settings");
  const invalidate = useInvalidateIntegrationClients();
  return $api.useMutation("put", "/api/integrations/{packageId}/oauth-clients/{clientId}", {
    onSuccess: () => {
      toast.success(t("integration.oauthClient.save.success"));
      invalidate();
    },
  });
}

/**
 * OAuth clients available to connect this auth: the org's custom (BYO-app)
 * client plus any platform-provided system clients, each with `source` and
 * which is the default. Secrets are never returned. Drives the detail page's
 * admin clients CRUD table (register/rotate/delete/set-default). New
 * connections always use the default — there is no per-connect picker.
 */
export function useIntegrationClients(packageId: string | undefined, authKey: string | undefined) {
  const scope = useOrgScope();
  return $api.useQuery(
    "get",
    "/api/integrations/{packageId}/auths/{authKey}/clients",
    {
      params: {
        path: { packageId: packageId ?? "", authKey: authKey ?? "" },
        header: scope.header,
      },
    },
    {
      enabled: scope.enabled && !!packageId && !!authKey,
      select: (envelope): IntegrationClient[] => envelope.data,
    },
  );
}

/**
 * Choose which OAuth client is the default for new connections on an auth — the
 * model-provider `setDefaultModel` analogue. Existing connections keep the
 * client that minted them; only future connects are affected. Refreshes the
 * clients list so the "default" badge updates.
 */
export function useSetDefaultIntegrationClient() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  return $api.useMutation("put", "/api/integrations/{packageId}/auths/{authKey}/default-client", {
    onSuccess: () => {
      toast.success(t("integration.clients.setDefault.success"));
      void qc.invalidateQueries({
        queryKey: ["get", "/api/integrations/{packageId}/auths/{authKey}/clients"],
      });
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

/** Delete one custom client by its id. */
export function useDeleteIntegrationOAuthClient() {
  const { t } = useTranslation("settings");
  const invalidate = useInvalidateIntegrationClients();
  return $api.useMutation("delete", "/api/integrations/{packageId}/oauth-clients/{clientId}", {
    onSuccess: () => {
      toast.success(t("integration.oauthClient.delete.success"));
      invalidate();
    },
  });
}
