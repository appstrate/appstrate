// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import type { EndUserInfo, EndUserListResponse } from "@appstrate/shared-types";
export type { EndUserInfo, EndUserListResponse } from "@appstrate/shared-types";

export interface EndUserListParams {
  limit?: number;
  startingAfter?: string;
}

export function useEndUsers(params?: EndUserListParams) {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["end-users", orgId, appId, params?.limit, params?.startingAfter],
    queryFn: () => {
      const searchParams = new URLSearchParams();
      if (params?.limit) searchParams.set("limit", String(params.limit));
      if (params?.startingAfter) searchParams.set("startingAfter", params.startingAfter);
      const qs = searchParams.toString();
      return api<EndUserListResponse>(`/end-users${qs ? `?${qs}` : ""}`);
    },
    enabled: !!orgId && !!appId,
  });
}

export function useEndUser(endUserId: string) {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["end-users", orgId, appId, endUserId],
    queryFn: () => api<EndUserInfo>(`/end-users/${endUserId}`),
    enabled: !!orgId && !!appId && !!endUserId,
  });
}

export function useCreateEndUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      name?: string;
      email?: string;
      externalId?: string;
      metadata?: Record<string, unknown>;
    }) => {
      return api<EndUserInfo>("/end-users", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["end-users"] });
    },
  });
}

export function useUpdateEndUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: {
        name?: string;
        email?: string;
        externalId?: string;
        metadata?: Record<string, unknown>;
      };
    }) => {
      return api<EndUserInfo>(`/end-users/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["end-users"] });
    },
  });
}

export function useDeleteEndUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      return api(`/end-users/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["end-users"] });
    },
  });
}
