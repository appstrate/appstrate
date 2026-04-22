// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, uploadFormData, apiBlob } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
// Profile resolution is now per-provider (server-side), no global profileId needed
import type {
  OrgPackageItem,
  OrgPackageItemDetail,
  AgentListItem,
  AgentDetail,
  PackageType,
  VersionListItem,
  VersionDetailResponse,
} from "@appstrate/shared-types";

// --- Packages — config-driven factory ---

const PACKAGE_CONFIG = {
  agent: { path: "agents", listKey: "agents", detailKey: "agent" },
  skill: { path: "skills", listKey: "skills", detailKey: "skill" },
  tool: { path: "tools", listKey: "tools", detailKey: "tool" },
  provider: { path: "providers", listKey: "providers", detailKey: "provider" },
} as const;

type PackageDetailMap = {
  agent: AgentDetail;
  skill: OrgPackageItemDetail;
  tool: OrgPackageItemDetail;
  provider: OrgPackageItemDetail;
};

function usePackageList(type: PackageType) {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  const cfg = PACKAGE_CONFIG[type];
  return useQuery({
    queryKey: ["packages", cfg.path, orgId, appId],
    queryFn: async () => {
      const data = await api<Record<string, OrgPackageItem[]>>(`/packages/${cfg.path}`);
      return data[cfg.listKey] as OrgPackageItem[];
    },
    enabled: !!orgId && !!appId,
  });
}

function usePackageDetail<T extends PackageType>(type: T, id: string | undefined) {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  const cfg = PACKAGE_CONFIG[type];

  return useQuery({
    queryKey: ["packages", cfg.detailKey, orgId, appId, id],
    queryFn: async () => {
      const data = await api<Record<string, unknown>>(`/packages/${cfg.path}/${id}`);
      return data[cfg.detailKey] as PackageDetailMap[T];
    },
    enabled: !!orgId && !!appId && !!id,
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
      if (type === "provider") {
        qc.invalidateQueries({ queryKey: ["providers"] });
        qc.invalidateQueries({ queryKey: ["available-providers"] });
      }
    },
  });
}

function useDeletePackage(type: PackageType) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const cfg = PACKAGE_CONFIG[type];
  return useMutation({
    mutationFn: async (id: string) => {
      await api(`/packages/${cfg.path}/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["packages", cfg.path] });
      if (type === "provider") {
        qc.invalidateQueries({ queryKey: ["providers"] });
        qc.invalidateQueries({ queryKey: ["available-providers"] });
      }
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
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["agents", orgId, appId],
    queryFn: async () => {
      const data = await api<{ agents: AgentListItem[] }>("/agents");
      return data.agents;
    },
    enabled: !!orgId && !!appId,
  });
}

// --- Package download ---

export function usePackageDownload(scope: string | undefined, name: string | undefined) {
  const { t } = useTranslation("common");
  return useCallback(
    async (version: string) => {
      if (!scope || !name) return;
      try {
        const blob = await apiBlob(`/packages/${scope}/${name}/${version}/download`);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${scope.replace(/^@/, "")}-${name}-${version}.afps`;
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
        const path =
          `/agents/${scope}/${name}/bundle` +
          (version ? `?version=${encodeURIComponent(version)}` : "");
        const blob = await apiBlob(path);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${scope.replace(/^@/, "")}-${name}.afps-bundle`;
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

function packageBasePath(type: PackageType, packageId: string | undefined) {
  return `/packages/${PACKAGE_CONFIG[type].path}/${packageId}`;
}

export function useVersionDetail(
  type: PackageType,
  packageId: string | undefined,
  version: string | undefined,
) {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["version-detail", orgId, appId, type, packageId, version],
    queryFn: () =>
      api<VersionDetailResponse>(`${packageBasePath(type, packageId)}/versions/${version}`),
    enabled: !!orgId && !!appId && !!packageId && !!version,
  });
}

export function usePackageVersions(type: PackageType, packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["package-versions", orgId, appId, type, packageId],
    queryFn: async () => {
      const data = await api<{ versions: VersionListItem[] }>(
        `${packageBasePath(type, packageId)}/versions`,
      );
      return data.versions;
    },
    enabled: !!orgId && !!appId && !!packageId,
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
      qc.invalidateQueries({ queryKey: ["agents"] });
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
      qc.invalidateQueries({ queryKey: ["agents"] });
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
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["packages"] });
    },
  });
}

export function useVersionInfo(type: PackageType, packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["version-info", orgId, appId, type, packageId],
    queryFn: () =>
      api<{ latestPublishedVersion: string | null; activeVersion: string | null }>(
        `${packageBasePath(type, packageId!)}/versions/info`,
      ),
    enabled: !!orgId && !!appId && !!packageId,
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
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["packages"] });
    },
  });
}
