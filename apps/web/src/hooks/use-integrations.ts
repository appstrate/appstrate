// SPDX-License-Identifier: Apache-2.0

/**
 * React Query hooks for the AFPS integration marketplace (Phase 1.3).
 *
 * Hooks backed by `/api/integrations/*` through the typed OpenAPI client.
 * Query keys are the openapi-react-query `[method, path, init]` triples; the
 * spec-declared `X-Org-Id`/`X-Space-Id` headers ride in `init` so the
 * keys stay org/space-scoped — switching org or space refetches instead
 * of serving another scope's cached page.
 */

import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
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

// Spec-pinned narrowing for the integration detail endpoint. It takes the
// generated OpenAPI response shape verbatim (so a rename/removal of any
// non-`manifest` field breaks compilation) and narrows only the freeform AFPS
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
  // `active` is in that list because both management readers sort the space's
  // placements on it — the agent editor's connection block tells an active
  // dependency from a placed-but-off one, and the detail page drives the
  // switch. Were the field to leave the response, an optional type would make
  // both read `undefined` in silence instead of failing to compile.
  Required<Pick<RawIntegrationSummary, "id" | "orgId" | "source" | "active">> & {
    manifest: IntegrationManifestView;
  };
type RawIntegrationDetail =
  paths["/api/integrations/{packageId}"]["get"]["responses"]["200"]["content"]["application/json"];
export type IntegrationDetailWire = Omit<RawIntegrationDetail, "manifest"> & {
  manifest: IntegrationManifestView;
};
/**
 * One OAuth client offered for connecting an integration auth — a space or org
 * custom (BYO-app) client or a platform-provided system client. Spec-derived so
 * a rename/removal of any wire field breaks compilation. Secrets never present.
 */
export type IntegrationClient = NonNullable<
  paths["/api/integrations/{packageId}/auths/{authKey}/clients"]["get"]["responses"]["200"]["content"]["application/json"]["data"]
>[number];
import { useCurrentOrgId } from "./use-org";
import { useCurrentSpaceId } from "./use-current-space";
import { useOrgOnlyScope, useOrgScope } from "./use-org-scope";
import { usePermissions } from "./use-permissions";
import { invalidateSchedules } from "./use-schedules";

// Re-export wire types for component consumers — canonical definitions
// live in `@appstrate/shared-types/integrations.ts`.
// NB: the integration detail READ shape is NOT re-exported from shared-types —
// consumers must use the spec-derived IntegrationDetailWire (above), the exact
// shape the hook returns, so a spec rename/removal of any non-`manifest` field
// breaks compilation.
export type {
  AgentIntegrationEntry,
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
 * pins, org default, agent resolutions, OAuth clients) and the caller's
 * cross-org connection list, whose `locked_by` moves with pins and defaults.
 * Typed keys are `[method, "/api/integrations…", init]` — a key-prefix
 * invalidation can't span sibling path strings, so match on the path element.
 */
export function invalidateIntegrationQueries(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({
    predicate: (query) => {
      const path = query.queryKey[1];
      if (typeof path !== "string") return false;
      // The integration index is keyed `["packages","integrations",…]` and lists
      // the ACTIVE set, which is exactly what activation changes — so a row that
      // just got switched on (or off) has to stop being served from cache.
      // Without this, activating left every index still omitting it.
      if (query.queryKey[0] === "packages" && path === "integrations") return true;
      return (
        path.startsWith("/api/integrations") ||
        path === "/api/me/connections" ||
        // The per-agent connection-readiness query lives under /api/agents but
        // is driven entirely by connection state, so refresh it here too.
        path === "/api/agents/{scope}/{name}/connection-readiness"
      );
    },
  });
}

// ─────────────────────────────────────────────
// Hooks
// ─────────────────────────────────────────────

/** Every integration read guards on `integrations:read`, which no agent or run read implies. */
function useIntegrationsReadScope() {
  const scope = useOrgScope();
  const { can } = usePermissions();
  return { header: scope.header, enabled: scope.enabled && can("integrations:read") };
}

type IntegrationNameOf = (integrationId: string) => string;

/**
 * Display names of `integrationIds`, each from its own detail query — the one
 * {@link useIntegrationDetail} caches — fetched when uncached and readable. The
 * id stands in for any name that cannot be read.
 */
export async function loadIntegrationNames(
  qc: QueryClient,
  scope: { header: ReturnType<typeof useOrgScope>["header"]; enabled: boolean },
  integrationIds: readonly string[],
): Promise<IntegrationNameOf> {
  const names = new Map<string, string>();
  await Promise.all(
    integrationIds.map(async (packageId) => {
      const options = $api.queryOptions("get", "/api/integrations/{packageId}", {
        params: { path: { packageId }, header: scope.header },
      });
      const detail = scope.enabled
        ? await qc.ensureQueryData(options).catch(() => undefined)
        : qc.getQueryData<RawIntegrationDetail>(options.queryKey);
      const name = (detail as IntegrationDetailWire | undefined)?.manifest.display_name;
      if (name) names.set(packageId, name);
    }),
  );
  return (integrationId) => names.get(integrationId) ?? integrationId;
}

/** {@link loadIntegrationNames} in the current org/space scope. */
export function useIntegrationNames(): (
  integrationIds: readonly string[],
) => Promise<IntegrationNameOf> {
  const qc = useQueryClient();
  const scope = useIntegrationsReadScope();
  return (integrationIds) => loadIntegrationNames(qc, scope, integrationIds);
}

/**
 * Fetch the complete integration corpus for list surfaces that search and
 * filter client-side. The endpoint is paginated at 100 rows, so treating its
 * default first page as a complete catalogue would make the toolbar lie as
 * soon as an organisation crosses that boundary.
 */
export function useAllIntegrations(options?: { enabled?: boolean }) {
  const scope = useIntegrationsReadScope();
  return useQuery({
    queryKey: [
      "get",
      "/api/integrations",
      { params: { query: { limit: 100, offset: 0 }, header: scope.header } },
    ],
    // Off by default for callers that only need it in one of their states —
    // the catalogue asks only while its integrations tab is the one on screen.
    enabled: scope.enabled && (options?.enabled ?? true),
    queryFn: async (): Promise<IntegrationSummaryWire[]> => {
      const all: IntegrationSummaryWire[] = [];
      const limit = 100;
      let offset = 0;

      for (;;) {
        const { data: page } = await client.GET("/api/integrations", {
          params: {
            query: { limit, offset },
            header: scope.header,
          },
        });
        if (!page) throw new Error("Integration catalogue returned no response body");
        const rows = page.data as IntegrationSummaryWire[];
        all.push(...rows);
        if (!page.hasMore || rows.length === 0) return all;
        offset += rows.length;
      }
    },
  });
}

export function useIntegrationDetail(packageId: string | undefined) {
  const scope = useIntegrationsReadScope();
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

/**
 * The detail of each of `packageIds`, in order, each from the query {@link useIntegrationDetail}
 * caches. The detail is where an integration's `active` and `block_user_connections` are read: the
 * list is paginated, so a space with more than 100 integrations would misreport them.
 */
export function useIntegrationDetails(packageIds: readonly string[]) {
  const scope = useIntegrationsReadScope();
  return useQueries({
    queries: packageIds.map((packageId) => ({
      ...$api.queryOptions("get", "/api/integrations/{packageId}", {
        params: { path: { packageId }, header: scope.header },
      }),
      enabled: scope.enabled,
      // Spec-pinned (see IntegrationDetailWire): only `manifest` is narrowed.
      select: (data: RawIntegrationDetail) => data as IntegrationDetailWire,
    })),
  });
}

export function useIntegrationConnections(packageId: string | undefined) {
  const scope = useIntegrationsReadScope();
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
 * Query options for an (integration, agent) resolution verdict, shared by the
 * picker ({@link useIntegrationReadinessEntry}) and the launch-badge readiness
 * hook: one key, so the badge and the Connexions tab cannot disagree.
 */
function useAgentConnectionReadinessOptions(agentPackageId: string | undefined, version?: string) {
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  const { can } = usePermissions();
  const { scope, name } = agentPackageId
    ? splitPackageRef(agentPackageId)
    : { scope: "", name: "" };
  // The `version` selector rides in the key: an explicit `draft` and the
  // published version resolve different manifests, so their verdicts must not
  // share one cache entry.
  return $api.queryOptions(
    "get",
    "/api/agents/{scope}/{name}/connection-readiness",
    {
      params: {
        path: { scope, name },
        ...(version ? { query: { version } } : {}),
        header: {
          "X-Org-Id": orgId ?? undefined,
          "X-Space-Id": spaceId ?? undefined,
        },
      },
    },
    { enabled: Boolean(can("integrations:read") && orgId && spaceId && agentPackageId) },
  );
}

/**
 * Bulk connection readiness for an agent — ONE call that drives the launch
 * badge, the Connexions tab pickers, and the pre-run check. `blocks_run` /
 * `errors` mirror the run-kickoff 409 (run semantics); `integrations[]` carries
 * every declared integration's management verdict (includeInert) + a
 * `run_blocking` flag. Replaces the former N per-integration round-trips.
 */
export function useAgentConnectionReadiness(agentPackageId: string | undefined) {
  return useQuery(useAgentConnectionReadinessOptions(agentPackageId));
}

type AgentConnectionReadiness =
  paths["/api/agents/{scope}/{name}/connection-readiness"]["get"]["responses"]["200"]["content"]["application/json"];

/** One integration's verdict out of the bulk readiness payload. */
function resolutionOf(data: AgentConnectionReadiness, integrationId: string | undefined) {
  return (
    data.integrations.find((i) => i.integration_package_id === integrationId)?.resolution ?? null
  );
}

/**
 * Reader of the {@link useIntegrationReadinessEntry} verdict as the cache holds
 * it NOW, for a handler running after something already awaited the readiness
 * refetch (the connect popup does): the fresh value, without a second request.
 * Throws when that refetch failed — the cache then still holds the old verdict.
 */
export function useReadIntegrationResolution(
  integrationId: string,
  agentPackageId: string,
  version?: string,
) {
  const qc = useQueryClient();
  const { queryKey } = useAgentConnectionReadinessOptions(agentPackageId, version);
  return () => {
    const state = qc.getQueryState<AgentConnectionReadiness>(queryKey);
    if (state?.status === "error") throw state.error;
    return state?.data ? resolutionOf(state.data, integrationId) : null;
  };
}

/**
 * One declared integration's readiness entry (`resolution`, `run_blocking`, `required`), selected
 * out of the single bulk readiness query so the picker, badge, and modal share one cache entry.
 */
export function useIntegrationReadinessEntry(
  integrationId: string | undefined,
  agentPackageId: string | undefined,
  version?: string,
) {
  const options = useAgentConnectionReadinessOptions(agentPackageId, version);
  return useQuery({
    ...options,
    enabled: options.enabled && !!integrationId,
    select: (data) =>
      data.integrations.find((i) => i.integration_package_id === integrationId) ?? null,
  });
}

/**
 * Mint a hosted-connect-portal session (issue #769). Auth-type-agnostic: the
 * returned `connect_url` dispatches server-side to the provider OAuth screen or
 * the hosted credential form, so the caller never branches on the auth type.
 * Same body as the OAuth initiate (scopes / force_account_select / connection_id)
 * — scope-union + reconnect semantics are identical.
 */
export function useInitiateIntegrationConnect() {
  return useMutation({
    meta: { errorHandledByCaller: true },
    mutationFn: async (vars: {
      params: { path: { packageId: string; authKey: string } };
      body: {
        scopes?: string[];
        force_account_select?: boolean;
        connection_id?: string;
      };
    }) => {
      const { data } = await client.POST(
        "/api/integrations/{packageId}/auths/{authKey}/connect/session",
        vars,
      );
      if (!data) throw new Error("empty response");
      return data;
    },
  });
}

// ─────────────────────────────────────────────
// OAuth clients — space tier and org tier
// ─────────────────────────────────────────────

/** `space` clients override the org's for that space; `org` clients apply to every space. */
export type IntegrationClientTier = "space" | "org";

const SPACE_CLIENTS = "/api/integrations/{packageId}/auths/{authKey}/clients";
const ORG_CLIENTS = "/api/org-integrations/{scope}/{name}/auths/{authKey}/clients";

type AuthPath = { path: { packageId: string; authKey: string } };
type ClientPath = { path: { packageId: string; clientId: string } };
/** Org routes address the integration as `{scope}/{name}`; space routes by `{packageId}`. */
function orgAuthPath({ packageId, authKey }: AuthPath["path"]) {
  return { ...splitPackageRef(packageId), authKey };
}
function orgClientPath({ packageId, clientId }: ClientPath["path"]) {
  return { ...splitPackageRef(packageId), clientId };
}
type CreateOAuthClientBody =
  paths["/api/integrations/{packageId}/auths/{authKey}/oauth-clients"]["post"]["requestBody"]["content"]["application/json"];
type UpdateOAuthClientBody =
  paths["/api/integrations/{packageId}/oauth-clients/{clientId}"]["patch"]["requestBody"]["content"]["application/json"];
type SetDefaultClientBody =
  paths["/api/integrations/{packageId}/auths/{authKey}/default-client"]["put"]["requestBody"]["content"]["application/json"];

/**
 * Refreshes both lists: an org change re-badges the space list and can move its default.
 * No message when the table already shows the effect (a default moved, a row gone).
 */
function useClientMutationSuccess(messageKey?: string) {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  return () => {
    if (messageKey) toast.success(t(messageKey));
    for (const path of [SPACE_CLIENTS, ORG_CLIENTS, "/api/integrations/{packageId}"]) {
      void qc.invalidateQueries({ queryKey: ["get", path] });
    }
  };
}

/**
 * A tier's own clients plus the one default it inherits (org or system). New
 * connections always use the default — there is no per-connect picker.
 */
export function useIntegrationClients(
  tier: IntegrationClientTier,
  packageId: string | undefined,
  authKey: string | undefined,
) {
  const spaceScope = useIntegrationsReadScope();
  const orgScope = useOrgOnlyScope();
  const path = { packageId: packageId ?? "", authKey: authKey ?? "" };
  const ready = !!packageId && !!authKey;
  const orgPath = orgAuthPath(path);
  // One query per tier: literal paths keep the client typed.
  const space = $api.useQuery(
    "get",
    SPACE_CLIENTS,
    { params: { path, header: spaceScope.header } },
    {
      enabled: tier === "space" && spaceScope.enabled && ready,
      select: (envelope): IntegrationClient[] => envelope.data,
    },
  );
  const org = $api.useQuery(
    "get",
    ORG_CLIENTS,
    { params: { path: orgPath, header: orgScope.header } },
    {
      enabled: tier === "org" && orgScope.enabled && ready,
      select: (envelope): IntegrationClient[] => envelope.data,
    },
  );
  return tier === "space" ? space : org;
}

/** Register a custom (BYO-app) client; only a tier's first becomes its default. */
export function useCreateIntegrationOAuthClient(tier: IntegrationClientTier) {
  const onSuccess = useClientMutationSuccess("integration.oauthClient.save.success");
  return useMutation({
    mutationFn: async (vars: { params: AuthPath; body: CreateOAuthClientBody }) => {
      const { data } =
        tier === "space"
          ? await client.POST("/api/integrations/{packageId}/auths/{authKey}/oauth-clients", vars)
          : await client.POST(
              "/api/org-integrations/{scope}/{name}/auths/{authKey}/oauth-clients",
              {
                params: { path: orgAuthPath(vars.params.path) },
                body: vars.body,
              },
            );
      return data;
    },
    onSuccess,
  });
}

/** Update one custom client in place, by its id (its `client_id` is immutable). */
export function useUpdateIntegrationOAuthClient(tier: IntegrationClientTier) {
  const onSuccess = useClientMutationSuccess("integration.oauthClient.save.success");
  return useMutation({
    mutationFn: async (vars: { params: ClientPath; body: UpdateOAuthClientBody }) => {
      const { data } =
        tier === "space"
          ? await client.PATCH("/api/integrations/{packageId}/oauth-clients/{clientId}", vars)
          : await client.PATCH("/api/org-integrations/{scope}/{name}/oauth-clients/{clientId}", {
              params: { path: orgClientPath(vars.params.path) },
              body: vars.body,
            });
      return data;
    },
    onSuccess,
  });
}

/**
 * Choose the tier's default OAuth client for new connections. Existing
 * connections keep the client that minted them.
 */
export function useSetDefaultIntegrationClient(tier: IntegrationClientTier) {
  const onSuccess = useClientMutationSuccess();
  return useMutation({
    mutationFn: async (vars: { params: AuthPath; body: SetDefaultClientBody }) => {
      const { data } =
        tier === "space"
          ? await client.PUT("/api/integrations/{packageId}/auths/{authKey}/default-client", vars)
          : await client.PUT(
              "/api/org-integrations/{scope}/{name}/auths/{authKey}/default-client",
              {
                params: { path: orgAuthPath(vars.params.path) },
                body: vars.body,
              },
            );
      return data;
    },
    onSuccess,
  });
}

/**
 * Move one of the space's own clients to the org tier, inherited by every
 * space. Its id is unchanged, so existing connections keep working.
 */
export function usePromoteIntegrationOAuthClient() {
  const onSuccess = useClientMutationSuccess("integration.clients.promote.success");
  return useMutation({
    mutationFn: async (vars: { params: ClientPath }) => {
      const { data } = await client.POST(
        "/api/integrations/{packageId}/oauth-clients/{clientId}/promote",
        vars,
      );
      return data;
    },
    onSuccess,
  });
}

/** Also deletes the connections it minted — in every space for an org client. */
export function useDeleteIntegrationOAuthClient(tier: IntegrationClientTier) {
  const qc = useQueryClient();
  const clientsChanged = useClientMutationSuccess();
  return useMutation({
    mutationFn: async (vars: { params: ClientPath }) => {
      if (tier === "space") {
        await client.DELETE("/api/integrations/{packageId}/oauth-clients/{clientId}", vars);
      } else {
        await client.DELETE("/api/org-integrations/{scope}/{name}/oauth-clients/{clientId}", {
          params: { path: orgClientPath(vars.params.path) },
        });
      }
    },
    onSuccess: () => {
      clientsChanged();
      // Deleting the connections it minted disables schedules naming them.
      invalidateSchedules(qc);
    },
  });
}

// ─────────────────────────────────────────────
// Admin: block_user_connections + pins + connection metadata
// ─────────────────────────────────────────────

export function useIntegrationPins(packageId: string | undefined) {
  const scope = useIntegrationsReadScope();
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
 * R2 — the space's agents that declare this integration as a dependency. Used
 * by the centralised pin management table to populate the "pin a new agent"
 * picker.
 */
export function useAgentsConsumingIntegration(packageId: string | undefined) {
  const scope = useIntegrationsReadScope();
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
      /** The WHOLE pinned set — this write replaces it. */
      body: { connection_ids: string[] };
    }) => {
      const { data } = await client.PUT("/api/integrations/{packageId}/pins/{agentPackageId}", {
        ...vars,
      });
      return data;
    },
    onSuccess: () => {
      toast.success(t("integration.admin.pin.upserted"));
      // Admin pins top the resolver cascade: every readiness verdict moves with them.
      void invalidateIntegrationQueries(qc);
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
      void invalidateIntegrationQueries(qc);
    },
  });
}

// ─── Org default connection (cross-agent governance) ───────────────────────

export function useIntegrationOrgDefault(packageId: string | undefined) {
  const scope = useIntegrationsReadScope();
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
      /** The WHOLE default set — this write replaces it. */
      body: { connection_ids: string[]; enforce: boolean };
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
  const qc = useQueryClient();
  return useMutation({
    // 200 + the bare connection resource (#657) — same serializer as the
    // connections list.
    mutationFn: async (vars: {
      params: { path: { packageId: string; connectionId: string } };
      body: { label?: string; shared_space_ids?: string[] };
    }) => {
      const { data } = await client.PATCH(
        "/api/integrations/{packageId}/connections/{connectionId}",
        vars,
      );
      return data;
    },
    onSuccess: (_data, vars) => {
      // Unsharing disables other people's schedules naming the connection.
      if (vars.body.shared_space_ids) invalidateSchedules(qc);
      // A label shows on every picker and readiness view, not just the connection list.
      // Returned so the share editor stays disabled until the refetched sharing lands.
      return invalidateIntegrationQueries(qc);
    },
  });
}
