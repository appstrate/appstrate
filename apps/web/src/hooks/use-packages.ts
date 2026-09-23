// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { stripScope } from "@appstrate/core/naming";
import { PACKAGE_TYPE_ROUTE_SEGMENT } from "@appstrate/core/package-files";
import { asJSONSchemaObject } from "@appstrate/core/form";
import { client, type components } from "../api/client";
import { triggerBlobDownload } from "../lib/blob-download";
import { splitPackageRef } from "../lib/package-paths";
import { useCurrentOrgId } from "./use-org";
import { useCurrentSpaceId } from "./use-current-space";
import { ApiError } from "../api/errors";
import { packageKeys, agentsKeys, invalidatePackageFiles } from "../lib/query-keys";
import type {
  OrgPackageItem,
  OrgPackageItemDetail,
  AgentListItem,
  AgentDetail,
  PackageType,
  VersionListItem,
  VersionDetailResponse,
} from "@appstrate/shared-types";

// NOTE on query keys: these hooks keep their LEGACY React Query keys
// (["packages", ...], ["agents", ...], ["version-*", ...]) instead of the
// openapi-react-query [method, path, init] keys. The keys are cache-coupled
// across files: use-editor-state / use-library / use-models / use-proxies
// invalidate them after writes, and use-current-space resets them on
// space switch. Only the fetch layer is migrated to the typed client.

// --- Packages — one factory over the four types ---
//
// `PACKAGE_TYPE_ROUTE_SEGMENT` is `as const`, so the template paths below stay
// literal and the typed client still resolves each one to its operation.

/** A detail plus the response's `ETag` (sent back as `If-Match`); `null` when absent. */
export type Versioned<T> = T & { etag: string | null };

type PackageDetailMap = {
  agent: Versioned<AgentDetail>;
  skill: Versioned<OrgPackageItemDetail>;
  "mcp-server": Versioned<OrgPackageItemDetail>;
  integration: Versioned<OrgPackageItemDetail>;
};

/**
 * Normalize a spec AgentDetail (most fields optional on the wire) to the
 * asserted, non-optional shape consumers use. Every dependency group is mapped
 * explicitly — the spec fully declares the response, so no spread is needed to
 * carry "undeclared" fields.
 */
function normalizeAgentDetail(d: components["schemas"]["AgentDetail"]): AgentDetail {
  return {
    ...d,
    // display_name is optional (agent editor no longer forces it, issue #825);
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

/**
 * Normalize a spec OrgPackageItemDetail to the asserted detail shape.
 * `scope` / `created_by_name` / `used_by_agents` are not returned by the
 * detail endpoints (and never were) — defaulted like the legacy blind cast
 * left them, but with explicit values.
 */
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
): Promise<PackageDetailMap[T]>;
async function fetchPackageDetail(
  type: PackageType,
  packageId: string,
  version?: string,
): Promise<Versioned<AgentDetail | OrgPackageItemDetail>> {
  const path = splitPackageRef(packageId);
  // Omitted lets the server pick the definition this caller may see — their
  // draft when they may write the package, the latest published version
  // otherwise. An explicit `draft` is an author's read, and every type answers
  // it the same way (`403 draft_not_writable` for anybody else).
  const query = version ? { query: { version } } : {};
  if (type === "agent") {
    const { data, response } = await client.GET("/api/packages/agents/{scope}/{name}", {
      params: { path, ...query },
    });
    return { ...normalizeAgentDetail(data!), etag: response.headers.get("ETag") };
  }
  const { data, response } = await client.GET(
    `/api/packages/${PACKAGE_TYPE_ROUTE_SEGMENT[type]}/{scope}/{name}`,
    {
      params: { path, ...query },
    },
  );
  return { ...normalizePackageItemDetail(data!), etag: response.headers.get("ETag") };
}

/**
 * One type's INDEX for the current space: what runs here, and nothing else.
 *
 * `GET /api/packages/{type}` answers the active set — placed in this space and
 * switched on — which is the same rule every launch route checks, so a row on
 * this list is a row that can be used. What is placed here but switched off, and
 * what has merely been offered, lives in the space library (`/space/packages`),
 * the one management view. There is no selector: a narrower and a wider list
 * would be two answers to one question.
 */
function usePackageList(type: PackageType) {
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  const segment = PACKAGE_TYPE_ROUTE_SEGMENT[type];
  return useQuery({
    queryKey: packageKeys.list(segment, orgId, spaceId),
    queryFn: async (): Promise<OrgPackageItem[]> => {
      const { data } = await client.GET(`/api/packages/${segment}`);
      // The spec marks most item fields optional — normalize to the
      // non-optional shape consumers have always used. `scope` is not
      // returned by the list endpoints.
      return data!.data.map((item) => ({
        ...item,
        name: item.name,
        description: item.description,
        // Manifest-derived, emitted by every type's list mapper: the index
        // pages draw their cards and run their search off this row alone.
        icon: item.icon,
        keywords: item.keywords,
        scope: null,
        version: item.version,
        forked_from: item.forked_from,
        created_by: item.created_by,
        created_by_name: item.created_by_name ?? null,
        used_by_agents: item.used_by_agents,
        auto_installed: item.auto_installed,
      }));
    },
    enabled: !!orgId && !!spaceId,
  });
}

function usePackageDetail<T extends PackageType>(
  type: T,
  id: string | undefined,
  opts?: { enabled?: boolean; version?: string },
) {
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  const segment = PACKAGE_TYPE_ROUTE_SEGMENT[type];
  // The server's default projection and an explicit `draft` are two different
  // answers and must never share a cache entry.
  const version = opts?.version;

  return useQuery({
    queryKey: packageKeys.detail(segment, orgId, spaceId, id!, version ?? null),
    queryFn: () => fetchPackageDetail(type, id!, version),
    enabled: !!orgId && !!spaceId && !!id && (opts?.enabled ?? true),
  });
}

function useUploadPackage(type: PackageType) {
  const qc = useQueryClient();
  const segment = PACKAGE_TYPE_ROUTE_SEGMENT[type];
  return useMutation({
    mutationFn: async (file: File): Promise<{ id: string; version: string | null }> => {
      const fd = new FormData();
      fd.append("file", file);
      // Single-package ZIP import goes through the canonical multipart import
      // endpoint, which type-detects the package from the archive. The per-type
      // create endpoints are JSON-only (except mcp-server), so POSTing a ZIP to
      // `/api/packages/{type}` fails server-side — `/import` is the correct
      // route for every type. Concrete path → the multipart `file` body is
      // typed (Blob), so no cast is needed.
      const { data } = await client.POST("/api/packages/import", {
        body: { file },
        bodySerializer: () => fd,
      });
      // 201 → { packageId, type, version? }. `version` is the manifest version
      // of the imported draft (omitted when the manifest carries none).
      return { id: data!.packageId, version: data!.version ?? null };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: packageKeys.family(segment) });
    },
  });
}

function useDeletePackage(type: PackageType) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const segment = PACKAGE_TYPE_ROUTE_SEGMENT[type];
  return useMutation({
    mutationFn: async (id: string) => {
      await client.DELETE(`/api/packages/${segment}/{scope}/{name}`, {
        params: { path: splitPackageRef(id) },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: packageKeys.family(segment) });
      navigate("/");
    },
  });
}

/**
 * Move a package to another home space — `PUT /api/packages/{scope}/{name}/home`.
 *
 * The home is what authorizes every later edit (`packages.home_space_id`, RBAC
 * spec §6.9), and it is also a read grant: the destination gains sight of the
 * package and the old home may lose it. So this invalidates the family (detail
 * + lists), the agent catalog and the library, not just the one detail row.
 */
function useMovePackageHome(type: PackageType) {
  const qc = useQueryClient();
  const segment = PACKAGE_TYPE_ROUTE_SEGMENT[type];
  return useMutation({
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
      qc.invalidateQueries({ queryKey: packageKeys.family(segment) });
      qc.invalidateQueries({ queryKey: agentsKeys.all });
      void qc.invalidateQueries({ queryKey: ["get", "/api/library"] });
      // The space being left may have lost the package (`keepInPreviousHome:
      // false` drops its offer AND its placement row), so its own package
      // listing is stale too — not just this type's family.
      void qc.invalidateQueries({ queryKey: ["get", "/api/spaces/{spaceId}/packages"] });
    },
  });
}

// Re-export factory hooks for direct use
export {
  usePackageList,
  usePackageDetail,
  useUploadPackage,
  useDeletePackage,
  useMovePackageHome,
  type PackageType,
};

// --- Agents ---

/**
 * The agent index for the current space — the ACTIVE set, like every other
 * index ({@link usePackageList}). Every consumer (the index page, the dashboard,
 * the nav, the run list, the schedule pickers, the notification bell) reads it
 * as it comes: a listed agent is a runnable agent, so no surface has to gate a
 * launch control on an activation fact the row no longer carries.
 */
export function useAgents() {
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  return useQuery({
    queryKey: agentsKeys.list(orgId, spaceId),
    queryFn: async (): Promise<AgentListItem[]> => {
      const { data } = await client.GET("/api/agents");
      // The spec marks most item fields optional — normalize to the asserted
      // list shape. `forked_from` is not returned by the list endpoint.
      return data!.data.map((a) => ({
        ...a,
        // Fall back to the package id when display_name is empty (issue #825).
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
    },
    enabled: !!orgId && !!spaceId,
  });
}

// --- Package download ---

export function usePackageDownload(scope: string | undefined, name: string | undefined) {
  const { t } = useTranslation("common");
  return useCallback(
    async (version: string) => {
      if (!scope || !name) return;
      try {
        const { data } = await client.GET("/api/packages/{scope}/{name}/{version}/download", {
          params: { path: { scope, name, version } },
          parseAs: "blob",
        });
        triggerBlobDownload(data, `${stripScope(scope)}-${name}-${version}.afps`);
      } catch {
        toast.error(t("error.downloadFailed"));
      }
    },
    [scope, name, t],
  );
}

/**
 * Export an agent as a multi-package `.afps-bundle` (its transitive
 * dependency graph in one self-contained archive). Triggers a browser
 * download via the shared `triggerBlobDownload`. Optional `version` pins the
 * export to a specific release; defaults to the version resolved in the
 * current space.
 */
export function useAgentBundleExport(scope: string | undefined, name: string | undefined) {
  const { t } = useTranslation("common");
  return useCallback(
    async (version?: string) => {
      if (!scope || !name) return;
      try {
        const { data } = await client.GET("/api/agents/{scope}/{name}/bundle", {
          params: { path: { scope, name }, query: { version } },
          parseAs: "blob",
        });
        triggerBlobDownload(data, `${stripScope(scope)}-${name}.afps-bundle`);
      } catch {
        toast.error(t("error.downloadFailed"));
      }
    },
    [scope, name, t],
  );
}

// --- Version queries ---

export function useVersionDetail(
  type: PackageType,
  packageId: string | undefined,
  version: string | undefined,
) {
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  return useQuery({
    queryKey: ["version-detail", orgId, spaceId, type, packageId, version],
    queryFn: async (): Promise<VersionDetailResponse> => {
      const { data } = await client.GET(
        `/api/packages/${PACKAGE_TYPE_ROUTE_SEGMENT[type]}/{scope}/{name}/versions/{version}`,
        { params: { path: { ...splitPackageRef(packageId!), version: version! } } },
      );
      return data!;
    },
    enabled: !!orgId && !!spaceId && !!packageId && !!version,
  });
}

export function usePackageVersions(type: PackageType, packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  return useQuery({
    queryKey: ["package-versions", orgId, spaceId, type, packageId],
    queryFn: async (): Promise<VersionListItem[]> => {
      const { data } = await client.GET(
        `/api/packages/${PACKAGE_TYPE_ROUTE_SEGMENT[type]}/{scope}/{name}/versions`,
        { params: { path: splitPackageRef(packageId!) } },
      );
      return data!.data;
    },
    enabled: !!orgId && !!spaceId && !!packageId,
  });
}

// --- Version management mutations ---

export function useCreateVersion(type: PackageType, packageId: string) {
  const qc = useQueryClient();
  const segment = PACKAGE_TYPE_ROUTE_SEGMENT[type];
  return useMutation({
    /** `version` overrides the manifest's; `etag` refuses (412) a draft moved since it was read. */
    mutationFn: async ({
      version,
      etag,
    }: { version?: string; etag?: string | null } = {}): Promise<{
      id: number;
      version: string;
    }> => {
      // 201 → the created version resource, bare (issue #657).
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
      qc.invalidateQueries({ queryKey: ["package-versions"] });
      qc.invalidateQueries({ queryKey: ["version-detail"] });
      qc.invalidateQueries({ queryKey: ["version-info"] });
      qc.invalidateQueries({ queryKey: agentsKeys.all });
      qc.invalidateQueries({ queryKey: packageKeys.all });
      // A published artifact appeared or vanished: a pinned Files tab and any
      // dist-tag-resolved read of it are now wrong.
      invalidatePackageFiles(qc);
    },
    // A refusal that moved or settled the draft (`precondition_failed`: someone
    // wrote it; `no_changes`: the server cleared its dirty marker) leaves the page stale.
    onError: (err) => {
      if (
        err instanceof ApiError &&
        (err.code === "precondition_failed" || err.code === "no_changes")
      ) {
        qc.invalidateQueries({ queryKey: ["version-info"] });
        qc.invalidateQueries({ queryKey: agentsKeys.all });
        qc.invalidateQueries({ queryKey: packageKeys.all });
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
      qc.invalidateQueries({ queryKey: ["package-versions"] });
      qc.invalidateQueries({ queryKey: ["version-detail"] });
      qc.invalidateQueries({ queryKey: ["version-info"] });
      qc.invalidateQueries({ queryKey: agentsKeys.all });
      qc.invalidateQueries({ queryKey: packageKeys.all });
      // A published artifact appeared or vanished: a pinned Files tab and any
      // dist-tag-resolved read of it are now wrong.
      invalidatePackageFiles(qc);
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
      // 200 → the updated PACKAGE resource, bare (issue #657): the restore is
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
      qc.invalidateQueries({ queryKey: agentsKeys.all });
      qc.invalidateQueries({ queryKey: packageKeys.all });
      // A restore overwrites the DRAFT artifact wholesale.
      invalidatePackageFiles(qc);
    },
  });
}

export function useVersionInfo(type: PackageType, packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  return useQuery({
    queryKey: ["version-info", orgId, spaceId, type, packageId],
    queryFn: async (): Promise<{
      latest_published_version: string | null;
      active_version: string | null;
    }> => {
      const { data } = await client.GET(
        `/api/packages/${PACKAGE_TYPE_ROUTE_SEGMENT[type]}/{scope}/{name}/versions/info`,
        { params: { path: splitPackageRef(packageId!) } },
      );
      return {
        latest_published_version: data!.latest_published_version ?? null,
        active_version: data!.active_version ?? null,
      };
    },
    enabled: !!orgId && !!spaceId && !!packageId,
  });
}

// --- Fork ---

export function useForkPackage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ packageId, name }: { packageId: string; name?: string }) => {
      // 201 → the forked package resource, bare (issue #657): `id` is the new
      // package ID under org scope, `forked_from` the source package ID.
      const { data } = await client.POST("/api/packages/{scope}/{name}/fork", {
        params: { path: splitPackageRef(packageId) },
        body: name ? { name } : {},
      });
      return { id: data!.id, forked_from: data!.forked_from ?? null };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: agentsKeys.all });
      qc.invalidateQueries({ queryKey: packageKeys.all });
    },
  });
}
