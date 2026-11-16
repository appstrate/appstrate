// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { stripScope } from "@appstrate/core/naming";
import { PACKAGE_TYPE_ROUTE_SEGMENT } from "@appstrate/core/package-files";
import { asJSONSchemaObject } from "@appstrate/core/form";
import { $api, client, type components } from "../api/client";
import { downloadOrToast } from "../lib/blob-download";
import { splitPackageRef } from "../lib/package-paths";
import { generatedKeyPackage, keepPreviousWithin } from "../lib/query-state";
import { useOrgScope } from "./use-org-scope";
import { useCurrentOrgId } from "./use-org";
import { useCurrentSpaceId } from "./use-current-space";
import { usePermissions } from "./use-permissions";
import { useListScope } from "./use-org-scope";
import { useSpaces } from "./use-spaces";
import { onePerPackage, type InSpaces } from "../lib/across-spaces";
import { invalidateLibraries } from "./use-library";
import { invalidateIntegrationQueries } from "./use-integrations";
import { packagePermission, packageSightPermissions } from "@appstrate/core/permissions";
import { ApiError } from "../api/errors";
import {
  packageKeys,
  agentsKeys,
  invalidatePackageCaches,
  invalidatePaths,
  invalidateVersionCaches,
  invalidateVersionInfo,
} from "../lib/query-keys";
import type {
  IntegrationIndexItem,
  OrgPackageItem,
  OrgPackageItemDetail,
  AgentListItem,
  AgentDetail,
  PackageType,
  VersionListItem,
  VersionDetailResponse,
} from "@appstrate/shared-types";

// The package and agent lists keep LEGACY query keys (["packages", ...], ["agents", ...]): the run SSE
// patcher and the space-switch reset reach them by name. The version reads are typed.

// Each read gates ITSELF on its route's permission: a custom role may omit it, and the server would refuse.
function useCanReadPackages(type: PackageType): boolean {
  const { can } = usePermissions();
  return can(packagePermission(type, "read"));
}

function useCanSeePackage(type: PackageType): boolean {
  const { can } = usePermissions();
  return packageSightPermissions(type).some(can);
}

// --- Packages — one factory over the package types ---
// `PACKAGE_TYPE_ROUTE_SEGMENT` is `as const`, so the template paths stay literal for the typed client.

/** A detail plus the response's `ETag` (sent back as `If-Match`); `null` when absent. */
export type Versioned<T> = T & { etag: string | null };

type PackageDetailMap = {
  agent: Versioned<AgentDetail>;
  skill: Versioned<OrgPackageItemDetail>;
  integration: Versioned<OrgPackageItemDetail>;
};

/** Normalizes a spec AgentDetail (most fields optional on the wire) to the non-optional shape consumers use. */
function normalizeAgentDetail(d: components["schemas"]["AgentDetail"]): AgentDetail {
  return {
    ...d,
    // display_name is optional (agent editor does not force it);
    // fall back to the package id so labels never render blank.
    display_name: d.display_name || d.id,
    description: d.description ?? "",
    scope: d.scope ?? null,
    version: d.version ?? null,
    manifest: d.manifest,
    updatedAt: d.updatedAt ?? null,
    running_runs: d.running_runs,
    effective_timeout_seconds: d.effective_timeout_seconds,
    forked_from: d.forked_from,
    dependencies: d.dependencies,
    input: { ...d.input, schema: asJSONSchemaObject(d.input.schema) },
    output: d.output
      ? { ...d.output, schema: asJSONSchemaObject(d.output.schema ?? {}) }
      : undefined,
    last_run: d.last_run ?? null,
  };
}

/** Normalizes a spec OrgPackageItemDetail; `scope` / `created_by_name` / `used_by_agents` are not returned by the detail endpoints, so they are defaulted. */
function normalizePackageItemDetail(
  d: components["schemas"]["OrgPackageItemDetail"],
): OrgPackageItemDetail {
  return {
    ...d,
    name: d.name,
    description: d.description,
    scope: null,
    version: d.version,
    forked_from: d.forked_from,
    created_by: d.created_by,
    created_by_name: null,
    auto_installed: d.auto_installed,
    content: d.content,
    manifest: d.manifest,
    agents: d.agents,
  };
}

function fetchPackageDetail<T extends PackageType>(
  type: T,
  packageId: string,
  version?: string,
  spaceId?: string,
): Promise<PackageDetailMap[T]>;
async function fetchPackageDetail(
  type: PackageType,
  packageId: string,
  version?: string,
  /** The space to read FROM when not the current one (a package is readable only where placed); the middleware leaves a caller-set header alone. */
  spaceId?: string,
): Promise<Versioned<AgentDetail | OrgPackageItemDetail>> {
  const path = splitPackageRef(packageId);
  // Omitted: the server picks the draft for a writer, else the latest version. An explicit `draft` is an author's read (`403 draft_not_writable` for others).
  const query = version ? { query: { version } } : {};
  const headers = spaceId ? { headers: { "X-Space-Id": spaceId } } : {};
  if (type === "agent") {
    const { data, response } = await client.GET("/api/packages/agents/{scope}/{name}", {
      params: { path, ...query },
      ...headers,
    });
    return { ...normalizeAgentDetail(data!), etag: response.headers.get("ETag") };
  }
  const { data, response } = await client.GET(
    `/api/packages/${PACKAGE_TYPE_ROUTE_SEGMENT[type]}/{scope}/{name}`,
    {
      params: { path, ...query },
      ...headers,
    },
  );
  return { ...normalizePackageItemDetail(data!), etag: response.headers.get("ETag") };
}

/**
 * An index's rows as its lists hold them: each package once, its spaces in the order of the
 * reader's space listing. `sum`: the per-space counters to add up (a stable array).
 */
function useOnePerPackage<T extends { id: string; spaceId: string; home_space_id?: string | null }>(
  sum?: readonly (keyof T)[],
): (rows: T[]) => InSpaces<T>[] {
  const { data: spaces } = useSpaces();
  return useCallback(
    (rows) =>
      onePerPackage(
        rows,
        (spaces ?? []).map((space) => space.id),
        sum,
      ),
    [spaces, sum],
  );
}

/** What an agent row counts in its own space. */
const AGENT_COUNTERS = ["running_runs", "unread_count"] as const;

/** The integration index adds the `source` facts its page splits by. */
type PackageIndexItem<T extends PackageType> = T extends "integration"
  ? IntegrationIndexItem
  : OrgPackageItem;

type Segment = (typeof PACKAGE_TYPE_ROUTE_SEGMENT)[PackageType];

/**
 * One type's INDEX for the current space: the active set (placed and switched on, the launch routes' rule). Packages placed here but switched off (or never switched on) live in the catalogue's per-space view (`/catalogue/:type?view=spaces`).
 * `spanning` (any type but the agent, whose index is `useAgents`): every space the reader reaches instead (`GET /api/orgs/{orgId}/packages/…`), each package once with its spaces (`onePerPackage`) — asked by an index PAGE in « Vue d'ensemble », never by a surface of one space.
 */
function usePackageList<T extends PackageType>(
  type: T,
  ...[spanning = false]: T extends "agent" ? [] : [spanning?: boolean]
) {
  const segment: Segment = PACKAGE_TYPE_ROUTE_SEGMENT[type];
  const scope = useListScope(spanning, useCanReadPackages(type));
  return useQuery({
    queryKey: spanning
      ? packageKeys.acrossSpaces(segment, scope.orgId)
      : packageKeys.list(segment, scope.orgId, scope.spaceId),
    queryFn: () => fetchPackageIndex(type, scope.acrossOrgId),
    select: useOnePerPackage<PackageIndexItem<T>>(),
    enabled: scope.enabled,
    // No poll: an index carries nothing a run moves, and the writes that move it invalidate it.
  });
}

/**
 * The current space's index, or every space's of `acrossOrgId`. The agent index across spaces
 * is `fetchAgents`'s: asked here, it throws rather than answer the current space's. Exported for
 * its test.
 */
export async function fetchPackageIndex<T extends PackageType>(
  type: T,
  acrossOrgId: string | null,
): Promise<PackageIndexItem<T>[]> {
  const segment: Segment = PACKAGE_TYPE_ROUTE_SEGMENT[type];
  const rows = !acrossOrgId
    ? (await client.GET(`/api/packages/${segment}`)).data!.data
    : segment === "agents"
      ? unreachable("The agent index across spaces is fetchAgents's")
      : (
          await client.GET(`/api/orgs/{orgId}/packages/${segment}`, {
            params: { path: { orgId: acrossOrgId } },
          })
        ).data!.data;
  // Normalize the optional spec fields; `scope` is not returned by list endpoints. The spread
  // carries an integration row's own fields; `segment` is a union, so the cast ties them to `T`.
  return rows.map((item) => ({
    ...item,
    name: item.name,
    description: item.description,
    // Manifest-derived: index pages draw cards and search off this row alone.
    icon: item.icon,
    keywords: item.keywords,
    scope: null,
    version: item.version,
    forked_from: item.forked_from,
    created_by: item.created_by,
    created_by_name: item.created_by_name ?? null,
    used_by_agents: item.used_by_agents,
    auto_installed: item.auto_installed,
  })) as PackageIndexItem<T>[];
}

function unreachable(reason: string): never {
  throw new Error(reason);
}

/** {@link usePackageDetail}'s query, for an imperative `fetchQuery` that shares its cache entry. */
export function packageDetailQueryOptions<T extends PackageType>(
  type: T,
  scope: { orgId: string | null; spaceId: string | null },
  id: string,
  version?: string,
) {
  return {
    // The default projection and an explicit `draft` are different answers: never one cache entry.
    queryKey: packageKeys.detail(
      PACKAGE_TYPE_ROUTE_SEGMENT[type],
      scope.orgId,
      scope.spaceId,
      id,
      version ?? null,
    ),
    queryFn: () => fetchPackageDetail(type, id, version),
  };
}

function usePackageDetail<T extends PackageType>(
  type: T,
  id: string | undefined,
  opts?: { enabled?: boolean; version?: string },
) {
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  const canSee = useCanSeePackage(type);

  return useQuery({
    ...packageDetailQueryOptions(type, { orgId, spaceId }, id!, opts?.version),
    enabled: canSee && !!orgId && !!spaceId && !!id && (opts?.enabled ?? true),
  });
}

function useDeletePackage(type: PackageType) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { t } = useTranslation("settings");
  const segment = PACKAGE_TYPE_ROUTE_SEGMENT[type];
  return useMutation({
    mutationFn: async (id: string) => {
      await client.DELETE(`/api/packages/${segment}/{scope}/{name}`, {
        params: { path: splitPackageRef(id) },
      });
    },
    onSuccess: () => {
      // Stale, not refetched: the deleted package's own detail is still mounted until the navigation below.
      qc.invalidateQueries({ queryKey: packageKeys.family(segment), refetchType: "none" });
      if (type === "agent") qc.invalidateQueries({ queryKey: agentsKeys.all });
      if (type === "integration") void invalidateIntegrationQueries(qc);
      toast.success(t("packages.deleted"));
      navigate("/");
    },
  });
}

/** `PUT /api/packages/{scope}/{name}/home`. The home authorizes later edits (RBAC §6.9) and is a read grant, so this invalidates the family, the agent catalog and the library, not just the detail row. */
function useMovePackageHome(type: PackageType) {
  const qc = useQueryClient();
  return useMutation({
    // The move dialog shows a refusal under its fields.
    meta: { errorHandledByCaller: true },
    mutationFn: async ({
      id,
      homeSpaceId,
      keepInPreviousHome,
    }: {
      id: string;
      homeSpaceId: string;
      /** Does the space being left keep the package? Sent explicitly — the server defaults it to `true`. */
      keepInPreviousHome: boolean;
    }) => {
      await client.PUT("/api/packages/{scope}/{name}/home", {
        params: { path: splitPackageRef(id) },
        body: { home_space_id: homeSpaceId, keep_in_previous_home: keepInPreviousHome },
      });
    },
    onSuccess: () => {
      invalidatePackageCaches(qc);
      void invalidateLibraries(qc);
      // `keepInPreviousHome: false` withdraws the old space's placement, so its own listing is stale too.
      void invalidatePaths(qc, ["/api/spaces/{id}/packages"]);
      if (type === "integration") void invalidateIntegrationQueries(qc);
    },
  });
}

// Re-export factory hooks for direct use
export {
  // The imperative read, for a handler that has to KNOW before it writes.
  fetchPackageDetail,
  usePackageList,
  usePackageDetail,
  useDeletePackage,
  useMovePackageHome,
  type PackageType,
};

// --- Agents ---

/**
 * The agent index for the current space: the ACTIVE set ({@link usePackageList}), so a listed agent is a runnable one.
 * `spanning`: every space the reader reaches instead (`GET /api/orgs/{orgId}/agents`), each agent once with its spaces and its counters added up (`onePerPackage`), polled — asked by the agent index and the dashboard in « Vue d'ensemble », never by a surface of one space.
 * `enabled: false` asks nothing (a surface that does not show it).
 */
export function useAgents(spanning = false, enabled = true) {
  const scope = useListScope(spanning, useCanSeePackage("agent"));
  return useQuery({
    queryKey: spanning
      ? agentsKeys.acrossSpaces(scope.orgId)
      : agentsKeys.list(scope.orgId, scope.spaceId),
    queryFn: () => fetchAgents(scope.acrossOrgId),
    select: useOnePerPackage<AgentListItem>(AGENT_COUNTERS),
    enabled: enabled && scope.enabled,
    // The running and unread counts of other spaces' agents reach no SSE stream here.
    refetchInterval: scope.refetchInterval,
  });
}

/** The current space's agent index, or every space's of `acrossOrgId`. Exported for its test. */
export async function fetchAgents(acrossOrgId: string | null): Promise<AgentListItem[]> {
  const { data } = acrossOrgId
    ? await client.GET("/api/orgs/{orgId}/agents", { params: { path: { orgId: acrossOrgId } } })
    : await client.GET("/api/agents");
  // The spec marks most item fields optional — normalize to the asserted
  // list shape. `forked_from` is not returned by the list endpoint.
  return data!.data.map((a) => ({
    ...a,
    // Fall back to the package id when display_name is empty.
    display_name: a.display_name || a.id,
    description: a.description ?? "",
    schema_version: a.schema_version ?? "",
    author: a.author ?? "",
    keywords: a.keywords ?? [],
    scope: a.scope ?? null,
    version: a.version ?? null,
    forked_from: null,
    running_runs: a.running_runs ?? 0,
    dependencies: a.dependencies,
  }));
}

// --- Package download ---

export function usePackageDownload(scope: string | undefined, name: string | undefined) {
  return useCallback(
    async (version: string) => {
      if (!scope || !name) return;
      await downloadOrToast(
        () =>
          client.GET("/api/packages/{scope}/{name}/{version}/download", {
            params: { path: { scope, name, version } },
            parseAs: "blob",
          }),
        `${stripScope(scope)}-${name}-${version}.afps`,
      );
    },
    [scope, name],
  );
}

/** Exports an agent as a multi-package `.afps-bundle` via `downloadOrToast`; `version` pins a release, defaulting to the one resolved in the current space. */
export function useAgentBundleExport(scope: string | undefined, name: string | undefined) {
  return useCallback(
    async (version?: string) => {
      if (!scope || !name) return;
      await downloadOrToast(
        () =>
          client.GET("/api/agents/{scope}/{name}/bundle", {
            params: { path: { scope, name }, query: { version } },
            parseAs: "blob",
          }),
        `${stripScope(scope)}-${name}.afps-bundle`,
      );
    },
    [scope, name],
  );
}

// --- Version queries ---

export function useVersionDetail(
  type: PackageType,
  packageId: string | undefined,
  version: string | undefined,
) {
  const scope = useOrgScope();
  const canRead = useCanReadPackages(type);
  return $api.useQuery(
    "get",
    `/api/packages/${PACKAGE_TYPE_ROUTE_SEGMENT[type]}/{scope}/{name}/versions/{version}`,
    {
      params: {
        header: scope.header,
        path: { ...splitPackageRef(packageId ?? ""), version: version ?? "" },
      },
    },
    {
      select: (data): VersionDetailResponse => data,
      enabled: canRead && scope.enabled && !!packageId && !!version,
      // Another version of the same package keeps the page drawn while it loads.
      placeholderData: keepPreviousWithin(
        packageId && version ? packageId : undefined,
        generatedKeyPackage,
      ),
    },
  );
}

export function usePackageVersions(type: PackageType, packageId: string | undefined) {
  const scope = useOrgScope();
  const canRead = useCanReadPackages(type);
  return $api.useQuery(
    "get",
    `/api/packages/${PACKAGE_TYPE_ROUTE_SEGMENT[type]}/{scope}/{name}/versions`,
    { params: { header: scope.header, path: splitPackageRef(packageId ?? "") } },
    {
      select: (e): VersionListItem[] => e.data,
      enabled: canRead && scope.enabled && !!packageId,
    },
  );
}

// --- Version management mutations ---

export function useCreateVersion(type: PackageType, packageId: string) {
  const qc = useQueryClient();
  const segment = PACKAGE_TYPE_ROUTE_SEGMENT[type];
  return useMutation({
    meta: { errorHandledByCaller: true },
    /** `version` overrides the manifest's; `etag` refuses (412) a draft moved since it was read. */
    mutationFn: async ({
      version,
      etag,
    }: { version?: string; etag?: string | null } = {}): Promise<{
      id: number;
      version: string;
    }> => {
      // 201 → the created version resource, bare.
      const { data } = await client.POST(`/api/packages/${segment}/{scope}/{name}/versions`, {
        params: {
          path: splitPackageRef(packageId),
          ...(etag ? { header: { "If-Match": etag } } : {}),
        },
        body: version ? { version } : undefined,
      });
      return { id: data!.id, version: data!.version };
    },
    onSuccess: () => {
      invalidateVersionCaches(qc);
    },
    // A refusal that moved or settled the draft (`precondition_failed`: someone
    // wrote it; `no_changes`: the server cleared its dirty marker) leaves the page stale.
    onError: (err) => {
      if (
        err instanceof ApiError &&
        (err.code === "precondition_failed" || err.code === "no_changes")
      ) {
        void invalidateVersionInfo(qc);
        invalidatePackageCaches(qc);
      }
    },
  });
}

export function useDeleteVersion(type: PackageType, packageId: string) {
  const qc = useQueryClient();
  const segment = PACKAGE_TYPE_ROUTE_SEGMENT[type];
  return useMutation({
    mutationFn: async (version: string) => {
      await client.DELETE(`/api/packages/${segment}/{scope}/{name}/versions/{version}`, {
        params: { path: { ...splitPackageRef(packageId), version } },
      });
    },
    onSuccess: () => {
      invalidateVersionCaches(qc);
    },
  });
}

export function useRestoreVersion(type: PackageType, packageId: string) {
  const qc = useQueryClient();
  const segment = PACKAGE_TYPE_ROUTE_SEGMENT[type];
  return useMutation({
    mutationFn: async (
      version: string,
    ): Promise<{ id: string; version: string | null; etag: string | null }> => {
      // 200 → the updated PACKAGE resource, bare: the restore is
      // reflected in `version`/`manifest`/`content`; its `ETag` is the new draft version.
      const { data, response } = await client.POST(
        `/api/packages/${segment}/{scope}/{name}/versions/{version}/restore`,
        { params: { path: { ...splitPackageRef(packageId), version } } },
      );
      return {
        id: data!.id,
        version: data!.version ?? null,
        etag: response.headers.get("ETag"),
      };
    },
    onSuccess: () => {
      // A restore overwrites the DRAFT artifact wholesale.
      invalidatePackageCaches(qc);
    },
  });
}

export function useVersionInfo(type: PackageType, packageId: string | undefined) {
  const scope = useOrgScope();
  const canRead = useCanReadPackages(type);
  return $api.useQuery(
    "get",
    `/api/packages/${PACKAGE_TYPE_ROUTE_SEGMENT[type]}/{scope}/{name}/versions/info`,
    { params: { header: scope.header, path: splitPackageRef(packageId ?? "") } },
    {
      select: (data) => ({
        latest_published_version: data.latest_published_version ?? null,
        active_version: data.active_version ?? null,
      }),
      enabled: canRead && scope.enabled && !!packageId,
    },
  );
}

// --- Fork ---

export function useForkPackage() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorHandledByCaller: true },
    mutationFn: async ({ packageId, name }: { packageId: string; name?: string }) => {
      // 201 → the forked package resource, bare: `id` is the new
      // package ID under org scope, `forked_from` the source package ID.
      const { data } = await client.POST("/api/packages/{scope}/{name}/fork", {
        params: { path: splitPackageRef(packageId) },
        body: name ? { name } : {},
      });
      return { id: data!.id, forked_from: data!.forked_from ?? null };
    },
    onSuccess: () => {
      invalidatePackageCaches(qc);
      // The copy may be an integration, whose list is keyed apart from the package family.
      void invalidateIntegrationQueries(qc);
    },
  });
}
