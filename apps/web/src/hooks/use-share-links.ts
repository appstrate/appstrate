import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";

export interface ShareLink {
  id: string;
  token: string;
  packageId: string;
  orgId: string;
  createdBy: string | null;
  endUserId: string | null;
  label: string | null;
  maxUses: number | null;
  isActive: boolean;
  usageCount: number;
  expiresAt: string;
  createdAt: string;
}

export interface ShareLinkUsage {
  id: string;
  shareLinkId: string;
  executionId: string | null;
  ip: string | null;
  userAgent: string | null;
  usedAt: string;
}

export function useShareLinks(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["shareLinks", orgId, packageId],
    queryFn: async () => {
      const res = await api<{ object: "list"; data: ShareLink[] }>(
        `/flows/${packageId}/share-links`,
      );
      return res.data;
    },
    enabled: !!packageId,
  });
}

function invalidateShareLinks(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["shareLinks"] });
}

export function useCreateShareLink(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      label?: string | null;
      maxUses?: number | null;
      expiresInDays?: number;
      version?: string;
    }) => {
      return api<ShareLink>(`/flows/${packageId}/share-links`, {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => invalidateShareLinks(qc),
  });
}

export function useUpdateShareLink(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...data
    }: {
      id: string;
      label?: string | null;
      maxUses?: number | null;
      isActive?: boolean;
      expiresAt?: string;
    }) => {
      return api<ShareLink>(`/flows/${packageId}/share-links/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => invalidateShareLinks(qc),
  });
}

export function useDeleteShareLink(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      return api(`/flows/${packageId}/share-links/${id}`, { method: "DELETE" });
    },
    onSuccess: () => invalidateShareLinks(qc),
  });
}
