import { useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, uploadFormData, apiBlob } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentProfileId } from "./use-current-profile";
import type {
  OrgPackageItem,
  OrgPackageItemDetail,
  FlowListItem,
  FlowDetail,
  PackageType,
} from "@appstrate/shared-types";

// --- Packages — config-driven factory ---

const PACKAGE_CONFIG = {
  flow: { path: "flows", listKey: "flows", detailKey: "flow" },
  skill: { path: "skills", listKey: "skills", detailKey: "skill" },
  tool: { path: "tools", listKey: "tools", detailKey: "tool" },
  provider: { path: "providers", listKey: "providers", detailKey: "provider" },
} as const;

type PackageDetailMap = {
  flow: FlowDetail;
  skill: OrgPackageItemDetail;
  tool: OrgPackageItemDetail;
  provider: OrgPackageItemDetail;
};

function usePackageList(type: PackageType) {
  const orgId = useCurrentOrgId();
  const cfg = PACKAGE_CONFIG[type];
  return useQuery({
    queryKey: ["packages", cfg.path, orgId],
    queryFn: async () => {
      const data = await api<Record<string, OrgPackageItem[]>>(`/packages/${cfg.path}`);
      return data[cfg.listKey] as OrgPackageItem[];
    },
  });
}

function usePackageDetail<T extends PackageType>(type: T, id: string | undefined) {
  const orgId = useCurrentOrgId();
  const profileId = useCurrentProfileId();
  const cfg = PACKAGE_CONFIG[type];

  // Flows support profileId for per-user service status resolution
  const qs = type === "flow" && profileId ? `?profileId=${profileId}` : "";
  // Include profileId in key for flows (different profiles = different results)
  const queryKey: unknown[] = ["packages", cfg.detailKey, orgId, id];
  if (type === "flow") queryKey.push(profileId);

  return useQuery({
    queryKey,
    queryFn: async () => {
      const data = await api<Record<string, unknown>>(`/packages/${cfg.path}/${id}${qs}`);
      return data[cfg.detailKey] as PackageDetailMap[T];
    },
    enabled: !!id,
  });
}

function useUploadPackage(type: PackageType) {
  const qc = useQueryClient();
  const cfg = PACKAGE_CONFIG[type];
  return useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return uploadFormData<{ packageId: string }>(`/packages/${cfg.path}`, fd);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["packages", cfg.path] });
    },
  });
}

function useDeletePackage(type: PackageType) {
  const qc = useQueryClient();
  const cfg = PACKAGE_CONFIG[type];
  return useMutation({
    mutationFn: async (id: string) => {
      await api(`/packages/${cfg.path}/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["packages", cfg.path] });
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

// --- Flows ---

export function useFlows() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["flows", orgId],
    queryFn: async () => {
      const data = await api<{ flows: FlowListItem[] }>("/flows");
      return data.flows;
    },
  });
}

// --- Package download ---

export function usePackageDownload(scope: string | undefined, name: string | undefined) {
  return useCallback(
    async (version: string) => {
      if (!scope || !name) return;
      try {
        const blob = await apiBlob(`/packages/${scope}/${name}/${version}/download`);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${scope.replace(/^@/, "")}-${name}-${version}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch {
        // silent fail, same as marketplace
      }
    },
    [scope, name],
  );
}

// --- Version queries ---

export interface VersionDetailResponse {
  id: number;
  version: string;
  manifest: Record<string, unknown>;
  content?: string | null;
  yanked: boolean;
  yankedReason: string | null;
  integrity: string;
  artifactSize: number;
  createdAt: string | null;
  distTags: string[];
}

export interface VersionListItem {
  id: number;
  version: string;
  integrity: string;
  artifactSize: number;
  yanked: boolean;
  createdBy: string | null;
  createdAt: string | null;
}

function packageBasePath(type: PackageType, packageId: string | undefined) {
  return `/packages/${PACKAGE_CONFIG[type].path}/${packageId}`;
}

export function useVersionDetail(
  type: PackageType,
  packageId: string | undefined,
  version: string | undefined,
) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["version-detail", orgId, type, packageId, version],
    queryFn: () =>
      api<VersionDetailResponse>(`${packageBasePath(type, packageId)}/versions/${version}`),
    enabled: !!packageId && !!version,
  });
}

export function usePackageVersions(type: PackageType, packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["package-versions", orgId, type, packageId],
    queryFn: async () => {
      const data = await api<{ versions: VersionListItem[] }>(
        `${packageBasePath(type, packageId)}/versions`,
      );
      return data.versions;
    },
    enabled: !!packageId,
  });
}

// --- Version management mutations ---

export function useCreateVersion(type: PackageType, packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (version?: string) => {
      return api<{ id: number; version: string; message: string }>(
        `${packageBasePath(type, packageId)}/versions`,
        {
          method: "POST",
          body: version ? JSON.stringify({ version }) : undefined,
        },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["package-versions"] });
      qc.invalidateQueries({ queryKey: ["version-detail"] });
      qc.invalidateQueries({ queryKey: ["version-info"] });
      qc.invalidateQueries({ queryKey: ["flows"] });
      qc.invalidateQueries({ queryKey: ["packages"] });
    },
  });
}

export function useDeleteVersion(type: PackageType, packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (version: string) =>
      api<void>(`${packageBasePath(type, packageId)}/versions/${version}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["package-versions"] });
      qc.invalidateQueries({ queryKey: ["version-detail"] });
      qc.invalidateQueries({ queryKey: ["version-info"] });
      qc.invalidateQueries({ queryKey: ["flows"] });
      qc.invalidateQueries({ queryKey: ["packages"] });
    },
  });
}

export function useRestoreVersion(type: PackageType, packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (version: string) =>
      api<{ message: string; restoredVersion: string; lockVersion: number }>(
        `${packageBasePath(type, packageId)}/versions/${version}/restore`,
        { method: "POST" },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flows"] });
      qc.invalidateQueries({ queryKey: ["packages"] });
    },
  });
}

export function useVersionInfo(type: PackageType, packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["version-info", orgId, type, packageId],
    queryFn: () =>
      api<{ latestVersion: string | null; draftVersion: string | null }>(
        `${packageBasePath(type, packageId!)}/versions/info`,
      ),
    enabled: !!packageId,
  });
}

// --- Fork ---

export function useForkPackage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ packageId, name }: { packageId: string; name?: string }) => {
      return api<{ packageId: string; type: string; forkedFrom: string }>(
        `/packages/${packageId}/fork`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(name ? { name } : {}),
        },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flows"] });
      qc.invalidateQueries({ queryKey: ["packages"] });
    },
  });
}
