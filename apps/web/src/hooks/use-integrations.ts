// SPDX-License-Identifier: Apache-2.0

/**
 * React Query hooks backed by `/api/integrations/*`. The `X-Org-Id`/`X-Space-Id` headers ride in
 * the query key's `init`, so switching org or space refetches instead of serving another scope's page.
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
import { invalidatePaths } from "../lib/query-keys";
import { splitPackageRef } from "../lib/package-paths";

// Spec-pinned: the generated response shape verbatim (a rename/removal of any non-`manifest`
// field breaks compilation), narrowing only the freeform AFPS `manifest` to IntegrationManifestView.
type RawIntegrationSummary = NonNullable<
  paths["/api/integrations"]["get"]["responses"]["200"]["content"]["application/json"]["data"]
>[number];
export type IntegrationSummaryWire = Omit<RawIntegrationSummary, "manifest"> &
  // `?fields=` projection makes the spec mark these optional; this hook never projects, so
  // re-require what consumers read (`active` too: a missing one would read `undefined` silently).
  Required<Pick<RawIntegrationSummary, "id" | "orgId" | "source" | "active">> & {
    manifest: IntegrationManifestView;
  };
type RawIntegrationDetail =
  paths["/api/integrations/{packageId}"]["get"]["responses"]["200"]["content"]["application/json"];
export type IntegrationDetailWire = Omit<RawIntegrationDetail, "manifest"> & {
  manifest: IntegrationManifestView;
};
/** One OAuth client offered for an integration auth: a space/org custom (BYO-app) or system client. Secrets never present. */
export type IntegrationClient = NonNullable<
  paths["/api/integrations/{packageId}/auths/{authKey}/clients"]["get"]["responses"]["200"]["content"]["application/json"]["data"]
>[number];
import { useCurrentOrgId } from "./use-org";
import { useCurrentSpaceId } from "./use-current-space";
import { useOrgOnlyScope, useOrgScope } from "./use-org-scope";
import { usePermissions } from "./use-permissions";
import { invalidateSchedules, warnSchedulesDisabled } from "./use-schedules";

// The detail READ shape is NOT re-exported from shared-types: consumers use IntegrationDetailWire.
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

/**
 * Invalidate every cached integrations read plus the caller's cross-org connection list
 * (`locked_by` moves with pins and defaults). Typed keys are `[method, path, init]`, so a
 * key-prefix invalidation can't span sibling paths: match on the path element.
 */
export function invalidateIntegrationQueries(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({
    predicate: (query) => {
      const path = query.queryKey[1];
      if (typeof path !== "string") return false;
      // The index lists the ACTIVE set, which activation changes.
      if (query.queryKey[0] === "packages" && path === "integrations") return true;
      return (
        path.startsWith("/api/integrations") ||
        path === "/api/me/connections" ||
        // Lives under /api/agents but is driven entirely by connection state.
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

/** Display names of `integrationIds` from the detail query cache (fetched when uncached and readable); the id stands in for an unreadable name. */
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

/** `GET /api/integrations` answers at most this many ids per request (its `id` filter's bound). */
const IDS_PER_REQUEST = 100;

/** The list rows of `ids` for the current space, chunked by {@link IDS_PER_REQUEST}. An id not placed here has no row; `undefined` until every request answered. */
export function useIntegrationsById(
  ids: readonly string[],
  options?: { enabled?: boolean },
): { data: IntegrationSummaryWire[] | undefined; isLoading: boolean; error: unknown } {
  const scope = useIntegrationsReadScope();
  // Sorted and unique, so the same set is the same keys whatever order it came in.
  const unique = [...new Set(ids)].sort();
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += IDS_PER_REQUEST) {
    chunks.push(unique.slice(i, i + IDS_PER_REQUEST));
  }
  return useQueries({
    queries: chunks.map((chunk) => ({
      ...$api.queryOptions("get", "/api/integrations", {
        params: { query: { id: chunk, limit: IDS_PER_REQUEST }, header: scope.header },
      }),
      enabled: scope.enabled && (options?.enabled ?? true),
    })),
    combine: (results) => ({
      data: results.every((result) => result.data)
        ? results.flatMap((result) => result.data!.data as IntegrationSummaryWire[])
        : undefined,
      isLoading: results.some((result) => result.isLoading),
      error: results.find((result) => result.error)?.error ?? null,
    }),
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

/** The detail of each of `packageIds`, in order. `active` and `block_user_connections` are read here: the list is paginated and would misreport them past 100 integrations. */
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

/** Query options of an agent's connection readiness: readers of the same version share one key, so they cannot disagree. */
function useAgentConnectionReadinessOptions(agentPackageId: string | undefined, version?: string) {
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  const { can } = usePermissions();
  const { scope, name } = agentPackageId
    ? splitPackageRef(agentPackageId)
    : { scope: "", name: "" };
  // `version` rides in the key: `draft` and the published version resolve different manifests.
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
 * Bulk connection readiness for an agent: ONE call driving the launch badge and the pickers.
 * `blocks_run`/`errors` mirror the run-kickoff 409; `integrations[]` carries every declared
 * integration's management verdict plus a `run_blocking` flag.
 */
export function useAgentConnectionReadiness(agentPackageId: string | undefined, version?: string) {
  return useQuery(useAgentConnectionReadinessOptions(agentPackageId, version));
}

type AgentConnectionReadiness =
  paths["/api/agents/{scope}/{name}/connection-readiness"]["get"]["responses"]["200"]["content"]["application/json"];

/** The declared integrations whose connection refuses a launch (the server's `run_blocking`). */
export function blockingIntegrationIds(data: AgentConnectionReadiness): string[] {
  return data.integrations.filter((i) => i.run_blocking).map((i) => i.integration_package_id);
}

/**
 * Reader of the readiness verdict as the cache holds it NOW, for a handler running after the
 * readiness refetch was awaited (the connect popup). Throws when that refetch failed.
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
    return (
      state?.data?.integrations.find((i) => i.integration_package_id === integrationId)
        ?.resolution ?? null
    );
  };
}

/** One declared integration's readiness entry (`resolution`, `run_blocking`, `required`), selected out of the bulk query. */
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

/** Mint a hosted-connect-portal session. Auth-type-agnostic: `connect_url` dispatches server-side to the OAuth screen or credential form. */
export function useInitiateIntegrationConnect() {
  return $api.useMutation("post", "/api/integrations/{packageId}/auths/{authKey}/connect/session", {
    meta: { errorHandledByCaller: true },
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

/** Refreshes both lists (an org change re-badges the space list). No toast when the table already shows the effect. */
function useClientMutationSuccess(messageKey?: string) {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  return () => {
    if (messageKey) toast.success(t(messageKey));
    void invalidatePaths(qc, [SPACE_CLIENTS, ORG_CLIENTS, "/api/integrations/{packageId}"]);
  };
}

/** A tier's own clients plus the default it inherits (org or system). New connections always use the default. */
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

/** Choose the tier's default OAuth client for new connections; existing ones keep the client that minted them. */
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

/** Move a space client to the org tier. Its id is unchanged, so existing connections keep working. */
export function usePromoteIntegrationOAuthClient() {
  const onSuccess = useClientMutationSuccess("integration.clients.promote.success");
  return $api.useMutation(
    "post",
    "/api/integrations/{packageId}/oauth-clients/{clientId}/promote",
    {
      onSuccess,
    },
  );
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

/** The space's agents that declare this integration as a dependency (feeds the "pin a new agent" picker). */
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
  return $api.useMutation("patch", "/api/integrations/{packageId}/settings", {
    onSuccess: () => {
      toast.success(t("integration.admin.blockUserConnections.updated"));
      void invalidatePaths(qc, ["/api/integrations/{packageId}"]);
    },
  });
}

export function useUpsertIntegrationPin() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  // The body is the WHOLE pinned set — this write replaces it.
  return $api.useMutation("put", "/api/integrations/{packageId}/pins/{agentPackageId}", {
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
  return $api.useMutation("delete", "/api/integrations/{packageId}/pins/{agentPackageId}", {
    onSuccess: ({ schedules_disabled_count: disabledCount }) => {
      if (disabledCount > 0) warnSchedulesDisabled(qc, disabledCount);
      else toast.success(t("integration.admin.pin.deleted"));
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
      // A 204 (no default set) maps to null.
      select: (data): IntegrationOrgDefault | null => data ?? null,
    },
  );
}

export function useUpsertIntegrationOrgDefault() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  // The body is the WHOLE default set — this write replaces it.
  return $api.useMutation("put", "/api/integrations/{packageId}/default", {
    onSuccess: () => {
      toast.success(t("integration.admin.orgDefault.updated"));
      // Agent-page picker verdicts depend on the org default.
      void invalidateIntegrationQueries(qc);
    },
  });
}

export function useDeleteIntegrationOrgDefault() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  return $api.useMutation("delete", "/api/integrations/{packageId}/default", {
    onSuccess: ({ schedules_disabled_count: disabledCount }) => {
      if (disabledCount > 0) warnSchedulesDisabled(qc, disabledCount);
      else toast.success(t("integration.admin.orgDefault.deleted"));
      void invalidateIntegrationQueries(qc);
    },
  });
}

export function useRenameIntegrationConnection() {
  const qc = useQueryClient();
  return $api.useMutation("patch", "/api/integrations/{packageId}/connections/{connectionId}", {
    // A label shows on every picker and readiness view, not just the connection list.
    onSuccess: () => invalidateIntegrationQueries(qc),
  });
}

/**
 * Share a connection into a space (idempotent) or withdraw it, through the space's door
 * (`packageId` set) or the account's. The mutation stays pending until the refetched sharing
 * lands, so the share editor never re-enables on stale state. Withdrawing disables other
 * actors' schedules naming the connection.
 */
export function useConnectionShare(op: "share" | "unshare", packageId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ connectionId, spaceId }: { connectionId: string; spaceId: string }) => {
      if (packageId) {
        const path = "/api/integrations/{packageId}/connections/{connectionId}/shares/{spaceId}";
        const init = { params: { path: { packageId, connectionId, spaceId } } };
        await (op === "share" ? client.PUT(path, init) : client.DELETE(path, init));
      } else {
        const path = "/api/me/connections/{connectionId}/shares/{spaceId}";
        const init = { params: { path: { connectionId, spaceId } } };
        await (op === "share" ? client.PUT(path, init) : client.DELETE(path, init));
      }
    },
    onSuccess: () => {
      if (op === "unshare") invalidateSchedules(qc);
      return invalidateIntegrationQueries(qc);
    },
  });
}

/** Explicit policy, atomically saved with current team-space shares by the server. */
export function useConnectionFutureSharing(packageId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ connectionId, enabled }: { connectionId: string; enabled: boolean }) => {
      const body = { include_future_spaces: enabled };
      if (packageId) {
        await client.PUT("/api/integrations/{packageId}/connections/{connectionId}/shares", {
          params: { path: { packageId, connectionId } },
          body,
        });
      } else {
        await client.PUT("/api/me/connections/{connectionId}/shares", {
          params: { path: { connectionId } },
          body,
        });
      }
    },
    onSuccess: () => invalidateIntegrationQueries(qc),
  });
}
