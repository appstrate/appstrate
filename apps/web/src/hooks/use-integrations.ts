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
type IntegrationSummaryWire = Omit<RawIntegrationSummary, "manifest"> &
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
type IntegrationDetailWire = Omit<RawIntegrationDetail, "manifest"> & {
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

// Re-export wire types for component consumers — canonical definitions
// live in `@appstrate/shared-types/integrations.ts`.
// NB: the integration list/detail READ shapes are NOT re-exported from
// shared-types — consumers must use the spec-derived IntegrationSummaryWire /
// IntegrationDetailWire (above), the exact shape the hooks return, so a spec
// rename/removal of any non-`manifest` field breaks compilation.
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
 * pins, org default, agent resolutions, OAuth clients). Typed keys are
 * `[method, "/api/integrations…", init]` — a key-prefix invalidation can't
 * span sibling path strings, so match on the path element instead.
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

export function useIntegrations() {
  const scope = useIntegrationsReadScope();
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
 * picker ({@link useIntegrationAgentResolution}) and the launch-badge readiness
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
  const options = useAgentConnectionReadinessOptions(agentPackageId, version);
  return useQuery({
    ...options,
    enabled: options.enabled && !!integrationId,
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
  const options = useAgentConnectionReadinessOptions(agentPackageId, version);
  return useQuery({
    ...options,
    enabled: options.enabled && !!integrationId,
    select: (data) =>
      data.integrations.find((i) => i.integration_id === integrationId)?.run_blocking ?? false,
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
        "/api/integrations/{packageId}/auths/{authKey}/connect/session",
        vars,
      );
      if (!data) throw new Error("empty response");
      return data;
    },
    onError: () => toast.error(t("integration.connect.error")),
  });
}

// ─────────────────────────────────────────────
// OAuth clients — space tier and org tier
// ─────────────────────────────────────────────

/**
 * Which tier of custom OAuth clients a hook targets. `space` rows override the
 * org's for that space; `org` rows (org context only, no space) are inherited
 * by every space. Both tiers take the same bodies and return the same shapes.
 */
export type IntegrationClientTier = "space" | "org";

const SPACE_CLIENTS = "/api/integrations/{packageId}/auths/{authKey}/clients";
const ORG_CLIENTS = "/api/org-integrations/{packageId}/auths/{authKey}/clients";

type AuthPath = { path: { packageId: string; authKey: string } };
type ClientPath = { path: { packageId: string; clientId: string } };
type CreateOAuthClientBody =
  paths["/api/integrations/{packageId}/auths/{authKey}/oauth-clients"]["post"]["requestBody"]["content"]["application/json"];
type RotateOAuthClientBody =
  paths["/api/integrations/{packageId}/oauth-clients/{clientId}"]["put"]["requestBody"]["content"]["application/json"];
type SetDefaultClientBody =
  paths["/api/integrations/{packageId}/auths/{authKey}/default-client"]["put"]["requestBody"]["content"]["application/json"];

/**
 * After any client mutation: both lists (an org change re-badges the space
 * list and can move its default) and the detail (`has_oauth_client`).
 */
function useClientMutationSuccess(messageKey: string) {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  return () => {
    toast.success(t(messageKey));
    for (const path of [SPACE_CLIENTS, ORG_CLIENTS, "/api/integrations/{packageId}"]) {
      void qc.invalidateQueries({ queryKey: ["get", path] });
    }
  };
}

/**
 * OAuth clients available to connect this auth, each with `source` and which
 * is the default. Space tier: space custom + inherited org + system clients,
 * `default_selectable` marking what the space may pick. Org tier: org custom +
 * system clients. Secrets are never returned. New connections always use the
 * default — there is no per-connect picker.
 */
export function useIntegrationClients(
  tier: IntegrationClientTier,
  packageId: string | undefined,
  authKey: string | undefined,
) {
  const spaceScope = useIntegrationsReadScope();
  const orgScope = useOrgOnlyScope();
  const { can } = usePermissions();
  const path = { packageId: packageId ?? "", authKey: authKey ?? "" };
  const ready = !!packageId && !!authKey;
  // One typed query per tier (literal paths keep the client typed); only the
  // selected tier's query is enabled.
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
    { params: { path, header: orgScope.header } },
    {
      enabled: tier === "org" && orgScope.enabled && can("org-integrations:configure") && ready,
      select: (envelope): IntegrationClient[] => envelope.data,
    },
  );
  return tier === "space" ? space : org;
}

/**
 * Register a NEW custom (BYO-app) OAuth client for an auth — repeatable. The
 * first of a tier becomes its default; later ones stay non-default until
 * promoted via {@link useSetDefaultIntegrationClient}.
 */
export function useCreateIntegrationOAuthClient(tier: IntegrationClientTier) {
  const onSuccess = useClientMutationSuccess("integration.oauthClient.save.success");
  return useMutation({
    mutationFn: async (vars: { params: AuthPath; body: CreateOAuthClientBody }) => {
      const { data } =
        tier === "space"
          ? await client.POST("/api/integrations/{packageId}/auths/{authKey}/oauth-clients", vars)
          : await client.POST(
              "/api/org-integrations/{packageId}/auths/{authKey}/oauth-clients",
              vars,
            );
      return data;
    },
    onSuccess,
  });
}

/** Rotate one custom client's credentials in place, by its id. */
export function useRotateIntegrationOAuthClient(tier: IntegrationClientTier) {
  const onSuccess = useClientMutationSuccess("integration.oauthClient.save.success");
  return useMutation({
    mutationFn: async (vars: { params: ClientPath; body: RotateOAuthClientBody }) => {
      const { data } =
        tier === "space"
          ? await client.PUT("/api/integrations/{packageId}/oauth-clients/{clientId}", vars)
          : await client.PUT("/api/org-integrations/{packageId}/oauth-clients/{clientId}", vars);
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
  const onSuccess = useClientMutationSuccess("integration.clients.setDefault.success");
  return useMutation({
    mutationFn: async (vars: { params: AuthPath; body: SetDefaultClientBody }) => {
      const { data } =
        tier === "space"
          ? await client.PUT("/api/integrations/{packageId}/auths/{authKey}/default-client", vars)
          : await client.PUT(
              "/api/org-integrations/{packageId}/auths/{authKey}/default-client",
              vars,
            );
      return data;
    },
    onSuccess,
  });
}

/**
 * Delete one custom client by its id — with the connections it minted (in the
 * space, or in every space of the org for an org client).
 */
export function useDeleteIntegrationOAuthClient(tier: IntegrationClientTier) {
  const onSuccess = useClientMutationSuccess("integration.oauthClient.delete.success");
  return useMutation({
    mutationFn: async (vars: { params: ClientPath }) => {
      if (tier === "space") {
        await client.DELETE("/api/integrations/{packageId}/oauth-clients/{clientId}", vars);
      } else {
        await client.DELETE("/api/org-integrations/{packageId}/oauth-clients/{clientId}", vars);
      }
    },
    onSuccess,
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
