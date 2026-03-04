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
} from "@appstrate/shared-types";

// --- Packages (skills / extensions) — config-driven factory ---

type PackageType = "skill" | "extension";

const PACKAGE_CONFIG = {
  skill: { path: "skills", listKey: "skills", detailKey: "skill" },
  extension: { path: "extensions", listKey: "extensions", detailKey: "extension" },
} as const;

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

function usePackageDetail(type: PackageType, id: string | undefined) {
  const orgId = useCurrentOrgId();
  const cfg = PACKAGE_CONFIG[type];
  return useQuery({
    queryKey: ["packages", cfg.detailKey, orgId, id],
    queryFn: async () => {
      const data = await api<Record<string, OrgPackageItemDetail>>(`/packages/${cfg.path}/${id}`);
      return data[cfg.detailKey] as OrgPackageItemDetail;
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
      return uploadFormData<Record<string, { id: string; name: string; description: string }>>(
        `/packages/${cfg.path}`,
        fd,
      );
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

function useUpdatePackageMetadata(type: PackageType) {
  const qc = useQueryClient();
  const cfg = PACKAGE_CONFIG[type];
  return useMutation({
    mutationFn: async ({
      id,
      ...data
    }: {
      id: string;
      name?: string;
      description?: string;
      version?: string;
      scopedName?: string;
    }) =>
      api(`/packages/${cfg.path}/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["packages"] });
      qc.invalidateQueries({ queryKey: ["version-info"] });
    },
  });
}

// Re-export factory hooks for direct use
export {
  usePackageList,
  usePackageDetail,
  useUploadPackage,
  useDeletePackage,
  useUpdatePackageMetadata,
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

export function useFlowDetail(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const profileId = useCurrentProfileId();
  return useQuery({
    queryKey: ["flow", orgId, packageId, profileId],
    queryFn: async () => {
      const qs = profileId ? `?profileId=${profileId}` : "";
      const data = await api<FlowDetail>(`/flows/${packageId}${qs}`);
      return data;
    },
    enabled: !!packageId,
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
  prompt?: string | null;
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

function packageBasePath(type: "flow" | "skill" | "extension", packageId: string | undefined) {
  return type === "flow" ? `/flows/${packageId}` : `/packages/${type}s/${packageId}`;
}

export function useVersionDetail(
  type: "flow" | "skill" | "extension",
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

export function usePackageVersions(
  type: "flow" | "skill" | "extension",
  packageId: string | undefined,
) {
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

export function useCreateVersion(type: "flow" | "skill" | "extension", packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      return api<{ id: number; version: string; message: string }>(
        `${packageBasePath(type, packageId)}/versions`,
        { method: "POST" },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["package-versions"] });
      qc.invalidateQueries({ queryKey: ["version-detail"] });
      qc.invalidateQueries({ queryKey: ["version-info"] });
      qc.invalidateQueries({ queryKey: ["flow"] });
      qc.invalidateQueries({ queryKey: ["flows"] });
      qc.invalidateQueries({ queryKey: ["packages"] });
    },
  });
}

export function useRestoreVersion(type: "flow" | "skill" | "extension", packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (version: string) =>
      api<{ message: string; restoredVersion: string; lockVersion: number }>(
        `${packageBasePath(type, packageId)}/versions/${version}/restore`,
        { method: "POST" },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flow"] });
      qc.invalidateQueries({ queryKey: ["flows"] });
      qc.invalidateQueries({ queryKey: ["packages"] });
    },
  });
}

export function useVersionInfo(
  type: "flow" | "skill" | "extension",
  packageId: string | undefined,
) {
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
