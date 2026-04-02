// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import type { ApplicationInfo } from "@appstrate/shared-types";
export type { ApplicationInfo } from "@appstrate/shared-types";

export function useApplications() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["applications", orgId],
    queryFn: () => api<{ data: ApplicationInfo[] }>("/applications").then((d) => d.data),
    enabled: !!orgId,
  });
}

export function useApplication(appId: string) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["applications", orgId, appId],
    queryFn: () => api<ApplicationInfo>(`/applications/${appId}`),
    enabled: !!orgId && !!appId,
  });
}

export function useCreateApplication() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      name: string;
      settings?: { allowedRedirectDomains?: string[] };
    }) => {
      return api<ApplicationInfo>("/applications", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["applications"] });
    },
  });
}

export function useUpdateApplication() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: { name?: string; settings?: { allowedRedirectDomains?: string[] } };
    }) => {
      return api<ApplicationInfo>(`/applications/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["applications"] });
    },
  });
}

export function useDeleteApplication() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      return api(`/applications/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["applications"] });
    },
  });
}
