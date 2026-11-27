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
import type {
  ConsumingAgentSummary,
  IntegrationConnection,
  IntegrationManifestView,
  IntegrationOrgDefault,
  IntegrationPin,
} from "@appstrate/shared-types";
import { $api, client, type paths } from "../api/client";
import { invalidatePaths } from "../lib/query-keys";
import { spaceHeader } from "../lib/scoping-headers";
import { splitPackageRef } from "../lib/package-paths";
import { connectionChoiceBody } from "../lib/integration-server-sync";

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
import { useOrgOnlyScope, useOrgScope, useSpaceReadScope } from "./use-org-scope";
import { usePermissions, useRowSpaceGrants } from "./use-permissions";
import { useCurrentOrgId } from "./use-org";
import { invalidateSchedules, warnSchedulesDisabled } from "./use-schedules";

// The detail READ shape is NOT re-exported from shared-types: consumers use IntegrationDetailWire.
export type {
  AgentIntegrationEntry,
  IntegrationAuthStatus,
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

type IntegrationNameOf = (integrationId: string) => string;

/** Resolve warned integration names in bulk, reusing scoped details that are already loaded. */
export async function loadIntegrationNames(
  qc: QueryClient,
  scope: { header: ReturnType<typeof useOrgScope>["header"]; enabled: boolean },
  integrationIds: readonly string[],
): Promise<IntegrationNameOf> {
  const names = new Map<string, string>();
  const missing: string[] = [];
  for (const packageId of new Set(integrationIds)) {
    const options = $api.queryOptions("get", "/api/integrations/{packageId}", {
      params: { path: { packageId }, header: scope.header },
    });
    const cached = qc.getQueryData<IntegrationDetailWire>(options.queryKey);
    if (cached?.manifest.display_name) names.set(packageId, cached.manifest.display_name);
    else missing.push(packageId);
  }
  await Promise.all(
    integrationIdChunks(missing).map(async (chunk) => {
      const options = integrationRowsOptions(scope.header, chunk);
      const rows = scope.enabled
        ? await qc.ensureQueryData(options).catch(() => undefined)
        : qc.getQueryData<IntegrationSummaryWire[]>(options.queryKey);
      for (const row of rows ?? []) {
        if (row.manifest.display_name) names.set(row.id, row.manifest.display_name);
      }
    }),
  );
  return (integrationId) => names.get(integrationId) ?? integrationId;
}

/** {@link loadIntegrationNames} in the current org/space scope. */
export function useIntegrationNames(): (
  integrationIds: readonly string[],
) => Promise<IntegrationNameOf> {
  const qc = useQueryClient();
  const scope = useSpaceReadScope("integrations:read");
  return (integrationIds) => loadIntegrationNames(qc, scope, integrationIds);
}

/** `GET /api/integrations` answers at most this many ids per request (its `id` filter's bound). */
const IDS_PER_REQUEST = 100;
/** The answer for no id, one array so it is the same value from render to render. */
const NO_ROWS: IntegrationSummaryWire[] = [];

function integrationIdChunks(ids: readonly string[]): string[][] {
  const unique = [...new Set(ids)].sort();
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += IDS_PER_REQUEST) {
    chunks.push(unique.slice(i, i + IDS_PER_REQUEST));
  }
  return chunks;
}

function integrationRowsOptions(header: ReturnType<typeof useOrgScope>["header"], ids: string[]) {
  return {
    queryKey: ["get", "/api/integrations", "by-id", header["X-Org-Id"], header["X-Space-Id"], ids],
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const responses = await Promise.all(
        integrationIdChunks(ids).map((chunk) =>
          client.GET("/api/integrations", {
            params: { query: { id: chunk, limit: IDS_PER_REQUEST }, header },
            signal,
          }),
        ),
      );
      return responses.flatMap((response) => response.data!.data as IntegrationSummaryWire[]);
    },
  };
}

/**
 * The list rows of `ids` for the current space, chunked by {@link IDS_PER_REQUEST}. An id not placed
 * here has no row; `undefined` until every request answered. When `ids` changes, the previous set's
 * rows stand in (`isPlaceholderData`) until the new set's answer.
 */
export function useIntegrationsById(
  ids: readonly string[],
  options?: { enabled?: boolean },
): {
  data: IntegrationSummaryWire[] | undefined;
  isLoading: boolean;
  isPlaceholderData: boolean;
  error: unknown;
} {
  const scope = useSpaceReadScope("integrations:read");
  const unique = [...new Set(ids)].sort();
  const orgId = scope.header["X-Org-Id"];
  const spaceId = scope.header["X-Space-Id"];
  const query = useQuery({
    ...integrationRowsOptions(scope.header, unique),
    enabled: scope.enabled && (options?.enabled ?? true),
    // One observer retains the combined result; useQueries cannot retain changed keys.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[3] === orgId && previousQuery?.queryKey[4] === spaceId
        ? previous
        : undefined,
  });
  return {
    data: unique.length === 0 ? NO_ROWS : query.data,
    isLoading: unique.length > 0 && query.isLoading,
    isPlaceholderData: unique.length > 0 && query.isPlaceholderData,
    error: query.error,
  };
}

export function useIntegrationDetail(packageId: string | undefined, spaceId?: string) {
  const scope = useSpaceReadScope("integrations:read", spaceId);
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

/** One space's read of an integration: what a list spanning spaces merges. */
export interface IntegrationDetailIn {
  spaceId: string;
  detail: IntegrationDetailWire;
}

/**
 * The integration's detail in each of `spaceIds` the reader may read it in, on the same keys as
 * {@link useIntegrationDetail} there. `sources` keeps `spaceIds`' order and holds only the answered
 * spaces; `isLoading` until every one answered; `error` the first refusal, never dropped silently.
 */
export function useIntegrationDetailsIn(
  packageId: string | undefined,
  spaceIds: readonly string[],
): { sources: IntegrationDetailIn[]; isLoading: boolean; error: unknown } {
  const orgId = useCurrentOrgId();
  const grants = useRowSpaceGrants();
  const readable = spaceIds.filter((spaceId) => grants(spaceId, "integrations:read"));
  return useQueries({
    queries: readable.map((spaceId) => ({
      ...$api.queryOptions("get", "/api/integrations/{packageId}", {
        params: {
          path: { packageId: packageId ?? "" },
          header: { "X-Org-Id": orgId ?? undefined, "X-Space-Id": spaceId },
        },
      }),
      enabled: !!orgId && !!packageId,
    })),
    combine: (results) => ({
      sources: results.flatMap((result, i) =>
        result.data
          ? [{ spaceId: readable[i]!, detail: result.data as IntegrationDetailWire }]
          : [],
      ),
      isLoading: results.some((result) => result.isLoading),
      error: results.find((result) => result.error)?.error ?? null,
    }),
  });
}

export function useIntegrationConnections(packageId: string | undefined) {
  const scope = useSpaceReadScope("integrations:read");
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

/** What the working space decided about the integration's tools (`integrations:configure` reads it to review). */
export function useIntegrationToolPolicy(packageId: string | undefined, enabled: boolean) {
  const scope = useOrgScope();
  return $api.useQuery(
    "get",
    "/api/integrations/{packageId}/tool-policy",
    { params: { path: { packageId: packageId ?? "" }, header: scope.header } },
    { enabled: enabled && scope.enabled && !!packageId },
  );
}

export type ToolPolicyAction = "approve" | "revoke" | "block" | "unblock";

/**
 * The tool policy's four writes. Each refreshes every integrations read: the detail's
 * `tool_catalog` statuses move with the policy. A refusal is toasted by the mutation cache.
 */
export function useIntegrationToolPolicyActions(packageId: string) {
  const qc = useQueryClient();
  const onSuccess = () => invalidateIntegrationQueries(qc);
  const path = { packageId };
  const approve = $api.useMutation("post", "/api/integrations/{packageId}/tool-policy/approvals", {
    onSuccess,
  });
  const revoke = $api.useMutation(
    "delete",
    "/api/integrations/{packageId}/tool-policy/approvals/{toolName}",
    { onSuccess },
  );
  const block = $api.useMutation("post", "/api/integrations/{packageId}/tool-policy/blocks", {
    onSuccess,
  });
  const unblock = $api.useMutation(
    "delete",
    "/api/integrations/{packageId}/tool-policy/blocks/{toolName}",
    { onSuccess },
  );
  const isPending = (action: ToolPolicyAction, name: string): boolean => {
    switch (action) {
      case "approve":
        return approve.isPending && !!approve.variables?.body.tools.some((t) => t.name === name);
      case "block":
        return block.isPending && !!block.variables?.body.tools.includes(name);
      case "revoke":
        return revoke.isPending && revoke.variables?.params.path.toolName === name;
      case "unblock":
        return unblock.isPending && unblock.variables?.params.path.toolName === name;
    }
  };
  return {
    /** `onDone` runs once the write succeeded (a confirmation closes then). */
    approve: (items: Parameters<typeof approve.mutate>[0]["body"]["tools"], onDone?: () => void) =>
      approve.mutate({ params: { path }, body: { tools: items } }, { onSuccess: onDone }),
    revoke: (toolName: string, onDone?: () => void) =>
      revoke.mutate({ params: { path: { ...path, toolName } } }, { onSuccess: onDone }),
    block: (name: string, onDone?: () => void) =>
      block.mutate({ params: { path }, body: { tools: [name] } }, { onSuccess: onDone }),
    unblock: (toolName: string) => unblock.mutate({ params: { path: { ...path, toolName } } }),
    /** Whether `action` is in flight for the tool `name`: a row waits on its own write only. */
    isPending,
    /** Whether any write is in flight for the tool `name`: its row is locked. */
    isBusy: (name: string): boolean =>
      (["approve", "revoke", "block", "unblock"] as const).some((action) =>
        isPending(action, name),
      ),
  };
}

/**
 * « Relire le serveur »: lists the remote server again and stores the snapshot. The refusal is
 * shown by the caller under its button, with the connection choice it may offer.
 */
export function useToolSnapshotRefresh(packageId: string) {
  const qc = useQueryClient();
  const refresh = $api.useMutation("post", "/api/integrations/{packageId}/tool-snapshot/refresh", {
    meta: { errorHandledByCaller: true },
    onSuccess: () => invalidateIntegrationQueries(qc),
  });
  const request = (connectionId?: string) => ({
    params: { path: { packageId } },
    body: connectionChoiceBody(connectionId),
  });
  return {
    isPending: refresh.isPending,
    error: refresh.error,
    run: (connectionId?: string) => refresh.mutate(request(connectionId)),
    runAsync: (connectionId?: string) => refresh.mutateAsync(request(connectionId)),
  };
}

/** Query options of an agent's connection readiness: readers of the same version share one key, so they cannot disagree. */
export function useAgentConnectionReadinessOptions(
  agentPackageId: string | undefined,
  version?: string,
  scheduleId?: string,
) {
  const orgScope = useOrgScope();
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
        ...(version || scheduleId ? { query: { version, scheduleId } } : {}),
        header: orgScope.header,
      },
    },
    { enabled: Boolean(can("integrations:read") && orgScope.enabled && agentPackageId) },
  );
}

/**
 * Bulk connection readiness for an agent: ONE call driving the launch badge and the pickers.
 * `blocks_run`/`errors` mirror the run-kickoff 409; `integrations[]` carries every declared
 * integration's management verdict plus a `run_blocking` flag.
 */
export function useAgentConnectionReadiness(
  agentPackageId: string | undefined,
  version?: string,
  scheduleId?: string,
) {
  return useQuery(useAgentConnectionReadinessOptions(agentPackageId, version, scheduleId));
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
  scheduleId?: string,
) {
  const qc = useQueryClient();
  const { queryKey } = useAgentConnectionReadinessOptions(agentPackageId, version, scheduleId);
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
  scheduleId?: string,
) {
  const options = useAgentConnectionReadinessOptions(agentPackageId, version, scheduleId);
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
function useClientMutationSuccess() {
  const qc = useQueryClient();
  return () => {
    void invalidatePaths(qc, [SPACE_CLIENTS, ORG_CLIENTS, "/api/integrations/{packageId}"]);
  };
}

/** A tier's own clients plus the default it inherits (org or system). New connections always use the default. */
export function useIntegrationClients(
  tier: IntegrationClientTier,
  packageId: string | undefined,
  authKey: string | undefined,
) {
  const spaceScope = useSpaceReadScope("integrations:read");
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
  const onSuccess = useClientMutationSuccess();
  return useMutation({
    // The client form shows a refusal under its fields.
    meta: { errorHandledByCaller: true },
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
  const onSuccess = useClientMutationSuccess();
  return useMutation({
    meta: { errorHandledByCaller: true },
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
  const onSuccess = useClientMutationSuccess();
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

export function useIntegrationPins(packageId: string | undefined, spaceId?: string) {
  const scope = useSpaceReadScope("integrations:read", spaceId);
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
export function useAgentsConsumingIntegration(packageId: string | undefined, spaceId?: string) {
  const scope = useSpaceReadScope("integrations:read", spaceId);
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
  const qc = useQueryClient();
  return $api.useMutation("patch", "/api/integrations/{packageId}/settings", {
    onSuccess: () => {
      void invalidatePaths(qc, ["/api/integrations/{packageId}"]);
    },
  });
}

export function useUpsertIntegrationPin() {
  const qc = useQueryClient();
  // The body is the WHOLE pin, its set and its additions flag (built by `pinDraftVerdict`): this write
  // replaces both, an absent flag closing the pin.
  return $api.useMutation("put", "/api/integrations/{packageId}/pins/{agentPackageId}", {
    // The pin form shows a refusal under its fields.
    meta: { errorHandledByCaller: true },
    onSuccess: () => {
      // Admin pins top the resolver cascade: every readiness verdict moves with them.
      void invalidateIntegrationQueries(qc);
    },
  });
}

export function useDeleteIntegrationPin() {
  const qc = useQueryClient();
  return $api.useMutation("delete", "/api/integrations/{packageId}/pins/{agentPackageId}", {
    onSuccess: ({ schedules_disabled_count: disabledCount }) => {
      if (disabledCount > 0) warnSchedulesDisabled(qc, disabledCount);
      void invalidateIntegrationQueries(qc);
    },
  });
}

// ─── Org default connection (cross-agent governance) ───────────────────────

export function useIntegrationOrgDefault(packageId: string | undefined) {
  const scope = useSpaceReadScope("integrations:read");
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
  const qc = useQueryClient();
  // The body is the WHOLE default set — this write replaces it.
  return $api.useMutation("put", "/api/integrations/{packageId}/default", {
    onSuccess: ({ schedules_disabled_count: disabledCount }) => {
      // An enforced default turned soft disables the schedules whose overrides only narrowed it.
      if (disabledCount > 0) warnSchedulesDisabled(qc, disabledCount);
      // Agent-page picker verdicts depend on the org default.
      void invalidateIntegrationQueries(qc);
    },
  });
}

export function useDeleteIntegrationOrgDefault() {
  const qc = useQueryClient();
  return $api.useMutation("delete", "/api/integrations/{packageId}/default", {
    onSuccess: ({ schedules_disabled_count: disabledCount }) => {
      if (disabledCount > 0) warnSchedulesDisabled(qc, disabledCount);
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
 * Share a connection into a space (idempotent) or withdraw it, through a space's door
 * (`packageId` set: `doorSpaceId`, the working space when omitted) or the account's. The mutation
 * stays pending until the refetched sharing lands, so the share editor never re-enables on stale
 * state. Withdrawing disables other actors' schedules naming the connection.
 */
export function useConnectionShare(
  op: "share" | "unshare",
  packageId?: string,
  doorSpaceId?: string,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ connectionId, spaceId }: { connectionId: string; spaceId: string }) => {
      if (packageId) {
        const path = "/api/integrations/{packageId}/connections/{connectionId}/shares/{spaceId}";
        const init = {
          params: { path: { packageId, connectionId, spaceId } },
          ...spaceHeader(doorSpaceId),
        };
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
export function useConnectionShareAllSpaces(packageId?: string, doorSpaceId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ connectionId, enabled }: { connectionId: string; enabled: boolean }) => {
      const body = { share_all_spaces: enabled };
      if (packageId) {
        await client.PUT("/api/integrations/{packageId}/connections/{connectionId}/shares", {
          params: { path: { packageId, connectionId } },
          body,
          ...spaceHeader(doorSpaceId),
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
