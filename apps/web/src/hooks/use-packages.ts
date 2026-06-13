// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { stripScope } from "@appstrate/core/naming";
import { asJSONSchemaObject } from "@appstrate/core/form";
import { client, type components } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import { packageKeys, agentsKeys } from "../lib/query-keys";
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
// invalidate them after writes, and use-current-application resets them on
// application switch. Only the fetch layer is migrated to the typed client.

// --- Packages — config-driven factory ---

const PACKAGE_CONFIG = {
  agent: { path: "agents" },
  skill: { path: "skills" },
  "mcp-server": { path: "mcp-servers" },
  integration: { path: "integrations" },
} as const;

type PackageDetailMap = {
  agent: AgentDetail;
  skill: OrgPackageItemDetail;
  "mcp-server": OrgPackageItemDetail;
  integration: OrgPackageItemDetail;
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
    display_name: d.display_name ?? "",
    description: d.description ?? "",
    scope: d.scope ?? null,
    version: d.version ?? null,
    manifest: d.manifest,
    updatedAt: d.updatedAt ?? null,
    lock_version: d.lock_version ?? 0,
    running_runs: d.running_runs ?? 0,
    forked_from: d.forked_from ?? null,
    dependencies: {
      skills: (d.dependencies?.skills ?? []).map((s) => ({ ...s, version: s.version ?? "" })),
      mcp_servers: d.dependencies?.mcp_servers ?? [],
      integrations: d.dependencies?.integrations ?? [],
    },
    config: {
      ...(d.config ?? {}),
      schema: asJSONSchemaObject(d.config?.schema ?? {}),
      current: d.config?.current ?? {},
    },
    input: d.input ? { ...d.input, schema: asJSONSchemaObject(d.input.schema ?? {}) } : undefined,
    output: d.output
      ? { ...d.output, schema: asJSONSchemaObject(d.output.schema ?? {}) }
      : undefined,
    last_run: d.last_run
      ? {
          ...d.last_run,
          id: d.last_run.id ?? "",
          status: d.last_run.status ?? "",
          started_at: d.last_run.started_at ?? null,
          duration: d.last_run.duration ?? null,
        }
      : null,
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
    name: d.name ?? null,
    description: d.description ?? null,
    scope: null,
    version: d.version ?? null,
    forked_from: d.forked_from ?? null,
    created_by: d.created_by ?? null,
    created_by_name: null,
    auto_installed: d.auto_installed ?? false,
    content: d.content ?? null,
    source_code: d.source_code ?? null,
    manifest: d.manifest,
    agents: (d.agents ?? []).map((a) => ({
      ...a,
      id: a.id ?? "",
      display_name: a.display_name ?? "",
    })),
  };
}

function fetchPackageDetail<T extends PackageType>(
  type: T,
  packageId: string,
): Promise<PackageDetailMap[T]>;
async function fetchPackageDetail(
  type: PackageType,
  packageId: string,
): Promise<AgentDetail | OrgPackageItemDetail> {
  const path = splitPackageRef(packageId);
  if (type === "agent") {
    const { data } = await client.GET("/api/packages/agents/{scope}/{name}", {
      params: { path },
    });
    return normalizeAgentDetail(data!);
  }
  const { data } = await client.GET(`/api/packages/${PACKAGE_CONFIG[type].path}/{scope}/{name}`, {
    params: { path },
  });
  return normalizePackageItemDetail(data!);
}

function usePackageList(type: PackageType, opts?: { activeOnly?: boolean }) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  const cfg = PACKAGE_CONFIG[type];
  const activeOnly = opts?.activeOnly ?? false;
  return useQuery({
    queryKey: packageKeys.list(cfg.path, orgId, applicationId, activeOnly ? "active" : "all"),
    queryFn: async (): Promise<OrgPackageItem[]> => {
      const { data } = await client.GET(`/api/packages/${cfg.path}`, {
        params: { query: activeOnly ? { active: "true" } : undefined },
      });
      // The spec marks most item fields optional — normalize to the
      // non-optional shape consumers have always used. `scope` is not
      // returned by the list endpoints.
      return data!.data.map((item) => ({
        ...item,
        name: item.name ?? null,
        description: item.description ?? null,
        scope: null,
        version: item.version ?? null,
        forked_from: item.forked_from ?? null,
        created_by: item.created_by ?? null,
        created_by_name: item.created_by_name ?? null,
        used_by_agents: item.used_by_agents ?? 0,
        auto_installed: item.auto_installed ?? false,
      }));
    },
    enabled: !!orgId && !!applicationId,
  });
}

function usePackageDetail<T extends PackageType>(
  type: T,
  id: string | undefined,
  opts?: { enabled?: boolean },
) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  const cfg = PACKAGE_CONFIG[type];

  return useQuery({
    queryKey: packageKeys.detail(cfg.path, orgId, applicationId, id!),
    queryFn: () => fetchPackageDetail(type, id!),
    enabled: !!orgId && !!applicationId && !!id && (opts?.enabled ?? true),
  });
}

function useUploadPackage(type: PackageType) {
  const qc = useQueryClient();
  const cfg = PACKAGE_CONFIG[type];
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
      qc.invalidateQueries({ queryKey: packageKeys.family(cfg.path) });
    },
  });
}

function useDeletePackage(type: PackageType) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const cfg = PACKAGE_CONFIG[type];
  return useMutation({
    mutationFn: async (id: string) => {
      await client.DELETE(`/api/packages/${cfg.path}/{scope}/{name}`, {
        params: { path: splitPackageRef(id) },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: packageKeys.family(cfg.path) });
      navigate("/");
    },
  });
}

// Re-export factory hooks for direct use
export {
  usePackageList,
  usePackageDetail,
  useUploadPackage,
  useDeletePackage,
  type PackageType,
  PACKAGE_CONFIG,
};

// --- Agents ---

export function useAgents() {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: agentsKeys.list(orgId, applicationId),
    queryFn: async (): Promise<AgentListItem[]> => {
      const { data } = await client.GET("/api/agents");
      // The spec marks most item fields optional — normalize to the asserted
      // list shape. `forked_from` is not returned by the list endpoint.
      return data!.data.map((a) => ({
        ...a,
        display_name: a.display_name ?? "",
        description: a.description ?? "",
        schema_version: a.schema_version ?? "",
        author: a.author ?? "",
        keywords: a.keywords ?? [],
        scope: a.scope ?? null,
        version: a.version ?? null,
        forked_from: null,
        running_runs: a.running_runs ?? 0,
        dependencies: a.dependencies ?? {},
      }));
    },
    enabled: !!orgId && !!applicationId,
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
        const url = URL.createObjectURL(data!);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${stripScope(scope)}-${name}-${version}.afps`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
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
 * download via `URL.createObjectURL` + an invisible `<a>`. Optional
 * `version` pins the export to a specific release; defaults to the
 * version installed in the current application.
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
        const url = URL.createObjectURL(data!);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${stripScope(scope)}-${name}.afps-bundle`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch {
        toast.error(t("error.downloadFailed"));
      }
    },
    [scope, name, t],
  );
}

// --- Version queries ---

export type { VersionDetailResponse, VersionListItem };

export function useVersionDetail(
  type: PackageType,
  packageId: string | undefined,
  version: string | undefined,
) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["version-detail", orgId, applicationId, type, packageId, version],
    queryFn: async (): Promise<VersionDetailResponse> => {
      const { data } = await client.GET(
        `/api/packages/${PACKAGE_CONFIG[type].path}/{scope}/{name}/versions/{version}`,
        { params: { path: { ...splitPackageRef(packageId!), version: version! } } },
      );
      // The spec marks every field optional — normalize to the asserted shape.
      return {
        ...data!,
        id: data!.id ?? 0,
        version: data!.version ?? "",
        manifest: data!.manifest ?? {},
        content: data!.content ?? null,
        yanked: data!.yanked ?? false,
        yanked_reason: data!.yanked_reason ?? null,
        integrity: data!.integrity ?? "",
        artifact_size: data!.artifact_size ?? 0,
        createdAt: data!.createdAt ?? null,
        dist_tags: data!.dist_tags ?? [],
      };
    },
    enabled: !!orgId && !!applicationId && !!packageId && !!version,
  });
}

export function usePackageVersions(type: PackageType, packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["package-versions", orgId, applicationId, type, packageId],
    queryFn: async (): Promise<VersionListItem[]> => {
      const { data } = await client.GET(
        `/api/packages/${PACKAGE_CONFIG[type].path}/{scope}/{name}/versions`,
        { params: { path: splitPackageRef(packageId!) } },
      );
      // The spec marks every field optional — normalize to the asserted shape.
      return (data!.versions ?? []).map((v) => ({
        ...v,
        id: v.id ?? 0,
        version: v.version ?? "",
        integrity: v.integrity ?? "",
        artifact_size: v.artifact_size ?? 0,
        yanked: v.yanked ?? false,
        created_by: v.created_by ?? null,
        createdAt: v.createdAt ?? null,
      }));
    },
    enabled: !!orgId && !!applicationId && !!packageId,
  });
}

// --- Version management mutations ---

export function useCreateVersion(type: PackageType, packageId: string) {
  const qc = useQueryClient();
  const cfg = PACKAGE_CONFIG[type];
  return useMutation({
    mutationFn: async (version?: string): Promise<{ id: number; version: string }> => {
      // 201 → the created version resource, bare (issue #657).
      const { data } = await client.POST(`/api/packages/${cfg.path}/{scope}/{name}/versions`, {
        params: { path: splitPackageRef(packageId) },
        body: version ? { version } : undefined,
      });
      return { id: data!.id ?? 0, version: data!.version ?? "" };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["package-versions"] });
      qc.invalidateQueries({ queryKey: ["version-detail"] });
      qc.invalidateQueries({ queryKey: ["version-info"] });
      qc.invalidateQueries({ queryKey: agentsKeys.all });
      qc.invalidateQueries({ queryKey: packageKeys.all });
    },
  });
}

export function useDeleteVersion(type: PackageType, packageId: string) {
  const qc = useQueryClient();
  const cfg = PACKAGE_CONFIG[type];
  return useMutation({
    mutationFn: async (version: string) => {
      await client.DELETE(`/api/packages/${cfg.path}/{scope}/{name}/versions/{version}`, {
        params: { path: { ...splitPackageRef(packageId), version } },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["package-versions"] });
      qc.invalidateQueries({ queryKey: ["version-detail"] });
      qc.invalidateQueries({ queryKey: ["version-info"] });
      qc.invalidateQueries({ queryKey: agentsKeys.all });
      qc.invalidateQueries({ queryKey: packageKeys.all });
    },
  });
}

export function useRestoreVersion(type: PackageType, packageId: string) {
  const qc = useQueryClient();
  const cfg = PACKAGE_CONFIG[type];
  return useMutation({
    mutationFn: async (
      version: string,
    ): Promise<{ id: string; version: string | null; lock_version: number }> => {
      // 200 → the updated PACKAGE resource, bare (issue #657): the restore is
      // reflected in `version`/`manifest`/`content` and the resource carries
      // the package's NEW `lock_version`.
      const { data } = await client.POST(
        `/api/packages/${cfg.path}/{scope}/{name}/versions/{version}/restore`,
        { params: { path: { ...splitPackageRef(packageId), version } } },
      );
      return {
        id: data!.id,
        version: data!.version ?? null,
        lock_version: data!.lock_version ?? 0,
      };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: agentsKeys.all });
      qc.invalidateQueries({ queryKey: packageKeys.all });
    },
  });
}

export function useVersionInfo(type: PackageType, packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["version-info", orgId, applicationId, type, packageId],
    queryFn: async (): Promise<{
      latest_published_version: string | null;
      active_version: string | null;
    }> => {
      const { data } = await client.GET(
        `/api/packages/${PACKAGE_CONFIG[type].path}/{scope}/{name}/versions/info`,
        { params: { path: splitPackageRef(packageId!) } },
      );
      return {
        latest_published_version: data!.latest_published_version ?? null,
        active_version: data!.active_version ?? null,
      };
    },
    enabled: !!orgId && !!applicationId && !!packageId,
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
