import { useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, uploadFormData, apiBlob } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentProfileId } from "./use-current-profile";
import type {
  OrgLibraryItem,
  OrgLibraryItemDetail,
  FlowListItem,
  FlowDetail,
} from "@appstrate/shared-types";

// --- Library (skills / extensions) — config-driven factory ---

type LibraryType = "skill" | "extension";

const LIBRARY_CONFIG = {
  skill: { path: "skills", listKey: "skills", detailKey: "skill" },
  extension: { path: "extensions", listKey: "extensions", detailKey: "extension" },
} as const;

function useLibraryList(type: LibraryType) {
  const orgId = useCurrentOrgId();
  const cfg = LIBRARY_CONFIG[type];
  return useQuery({
    queryKey: ["library", cfg.path, orgId],
    queryFn: async () => {
      const data = await api<Record<string, OrgLibraryItem[]>>(`/library/${cfg.path}`);
      return data[cfg.listKey] as OrgLibraryItem[];
    },
  });
}

function useLibraryDetail(type: LibraryType, id: string | undefined) {
  const orgId = useCurrentOrgId();
  const cfg = LIBRARY_CONFIG[type];
  return useQuery({
    queryKey: ["library", cfg.detailKey, orgId, id],
    queryFn: async () => {
      const data = await api<Record<string, OrgLibraryItemDetail>>(`/library/${cfg.path}/${id}`);
      return data[cfg.detailKey] as OrgLibraryItemDetail;
    },
    enabled: !!id,
  });
}

function useUploadLibrary(type: LibraryType) {
  const qc = useQueryClient();
  const cfg = LIBRARY_CONFIG[type];
  return useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return uploadFormData<Record<string, { id: string; name: string; description: string }>>(
        `/library/${cfg.path}`,
        fd,
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["library", cfg.path] });
    },
  });
}

function useDeleteLibrary(type: LibraryType) {
  const qc = useQueryClient();
  const cfg = LIBRARY_CONFIG[type];
  return useMutation({
    mutationFn: async (id: string) => {
      await api(`/library/${cfg.path}/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["library", cfg.path] });
    },
  });
}

function useUpdateLibraryMetadata(type: LibraryType) {
  const qc = useQueryClient();
  const cfg = LIBRARY_CONFIG[type];
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
      api(`/library/${cfg.path}/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["library"] });
    },
  });
}

// Re-export factory hooks for direct use
export {
  useLibraryList,
  useLibraryDetail,
  useUploadLibrary,
  useDeleteLibrary,
  useUpdateLibraryMetadata,
  type LibraryType,
  LIBRARY_CONFIG,
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

function libraryBasePath(type: "flow" | "skill" | "extension", packageId: string | undefined) {
  return type === "flow" ? `/flows/${packageId}` : `/library/${type}s/${packageId}`;
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
      api<VersionDetailResponse>(`${libraryBasePath(type, packageId)}/versions/${version}`),
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
        `${libraryBasePath(type, packageId)}/versions`,
      );
      return data.versions;
    },
    enabled: !!packageId,
  });
}
