import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, uploadFormData } from "../api";
import { useCurrentOrgId } from "./use-org";
import type {
  OrgSkill,
  OrgSkillDetail,
  OrgExtension,
  OrgExtensionDetail,
} from "@appstrate/shared-types";

// --- Skills ---

export function useOrgSkills() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["library", "skills", orgId],
    queryFn: async () => {
      const data = await api<{ skills: OrgSkill[] }>("/library/skills");
      return data.skills;
    },
  });
}

export function useOrgSkillDetail(skillId: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["library", "skill", orgId, skillId],
    queryFn: async () => {
      const data = await api<{ skill: OrgSkillDetail }>(`/library/skills/${skillId}`);
      return data.skill;
    },
    enabled: !!skillId,
  });
}

export function useUploadSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return uploadFormData<{ skill: { id: string; name: string; description: string } }>(
        "/library/skills",
        fd,
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["library", "skills"] });
    },
  });
}

export function useDeleteSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (skillId: string) => {
      await api(`/library/skills/${skillId}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["library", "skills"] });
    },
  });
}

// --- Extensions ---

export function useOrgExtensions() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["library", "extensions", orgId],
    queryFn: async () => {
      const data = await api<{ extensions: OrgExtension[] }>("/library/extensions");
      return data.extensions;
    },
  });
}

export function useOrgExtensionDetail(extId: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["library", "extension", orgId, extId],
    queryFn: async () => {
      const data = await api<{ extension: OrgExtensionDetail }>(`/library/extensions/${extId}`);
      return data.extension;
    },
    enabled: !!extId,
  });
}

export function useUploadExtension() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return uploadFormData<{ extension: { id: string; name: string; description: string } }>(
        "/library/extensions",
        fd,
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["library", "extensions"] });
    },
  });
}

export function useDeleteExtension() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (extId: string) => {
      await api(`/library/extensions/${extId}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["library", "extensions"] });
    },
  });
}

// --- Flow skill/extension reference mutations ---

export function useSetFlowSkills(flowId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (skillIds: string[]) => {
      return api(`/flows/${flowId}/skills`, {
        method: "PUT",
        body: JSON.stringify({ skillIds }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flow"] });
      qc.invalidateQueries({ queryKey: ["flows"] });
      qc.invalidateQueries({ queryKey: ["library", "skills"] });
    },
  });
}

export function useSetFlowExtensions(flowId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (extensionIds: string[]) => {
      return api(`/flows/${flowId}/extensions`, {
        method: "PUT",
        body: JSON.stringify({ extensionIds }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flow"] });
      qc.invalidateQueries({ queryKey: ["flows"] });
      qc.invalidateQueries({ queryKey: ["library", "extensions"] });
    },
  });
}
