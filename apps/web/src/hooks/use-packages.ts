import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, uploadFormData } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentProfileId } from "./use-current-profile";
import type {
  OrgSkill,
  OrgSkillDetail,
  OrgExtension,
  OrgExtensionDetail,
  FlowListItem,
  FlowDetail,
} from "@appstrate/shared-types";

// --- Library (skills / extensions) — config-driven factory ---

type LibraryType = "skill" | "extension";

const LIBRARY_CONFIG = {
  skill: { path: "skills", listKey: "skills", detailKey: "skill" },
  extension: { path: "extensions", listKey: "extensions", detailKey: "extension" },
} as const;

type ListTypeMap = { skill: OrgSkill; extension: OrgExtension };
type DetailTypeMap = { skill: OrgSkillDetail; extension: OrgExtensionDetail };

function useLibraryList<T extends LibraryType>(type: T) {
  const orgId = useCurrentOrgId();
  const cfg = LIBRARY_CONFIG[type];
  return useQuery({
    queryKey: ["library", cfg.path, orgId],
    queryFn: async () => {
      const data = await api<Record<string, ListTypeMap[T][]>>(`/library/${cfg.path}`);
      return data[cfg.listKey] as ListTypeMap[T][];
    },
  });
}

function useLibraryDetail<T extends LibraryType>(type: T, id: string | undefined) {
  const orgId = useCurrentOrgId();
  const cfg = LIBRARY_CONFIG[type];
  return useQuery({
    queryKey: ["library", cfg.detailKey, orgId, id],
    queryFn: async () => {
      const data = await api<Record<string, DetailTypeMap[T]>>(`/library/${cfg.path}/${id}`);
      return data[cfg.detailKey] as DetailTypeMap[T];
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

// Named exports for backward compatibility
export const useOrgSkills = () => useLibraryList("skill");
export const useOrgSkillDetail = (id: string | undefined) => useLibraryDetail("skill", id);
export const useUploadSkill = () => useUploadLibrary("skill");
export const useDeleteSkill = () => useDeleteLibrary("skill");

export const useOrgExtensions = () => useLibraryList("extension");
export const useOrgExtensionDetail = (id: string | undefined) => useLibraryDetail("extension", id);
export const useUploadExtension = () => useUploadLibrary("extension");
export const useDeleteExtension = () => useDeleteLibrary("extension");

// Re-export factory hooks for direct use
export { useLibraryList, useUploadLibrary, useDeleteLibrary, type LibraryType, LIBRARY_CONFIG };

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

// --- Composite hooks ---

export function usePackageDetail(id: string | undefined) {
  const skill = useOrgSkillDetail(id);
  const ext = useOrgExtensionDetail(id);
  return {
    isLoading: skill.isLoading || ext.isLoading,
    data: skill.data || ext.data,
    type: skill.data ? ("skill" as const) : ("extension" as const),
  };
}

export function useDeletePackage(type: "skill" | "extension") {
  return useDeleteLibrary(type);
}
