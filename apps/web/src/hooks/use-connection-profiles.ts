import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type {
  ConnectionProfile,
  UserConnectionItem,
  ProviderDisplayInfo,
} from "@appstrate/shared-types";

interface ProfileWithConnections extends ConnectionProfile {
  connectionCount: number;
}

export function useConnectionProfiles() {
  return useQuery({
    queryKey: ["connection-profiles"],
    queryFn: () =>
      api<{ profiles: ProfileWithConnections[] }>("/connection-profiles").then((r) => r.profiles),
  });
}

export function useAllUserConnections() {
  return useQuery({
    queryKey: ["user-connections"],
    queryFn: () =>
      api<{
        connections: UserConnectionItem[];
        providerInfo: Record<string, ProviderDisplayInfo>;
      }>("/connection-profiles/connections"),
  });
}

export function useCreateConnectionProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api<ConnectionProfile>("/connection-profiles", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["connection-profiles"] });
    },
  });
}

export function useRenameConnectionProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api(`/connection-profiles/${id}`, {
        method: "PUT",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["connection-profiles"] });
    },
  });
}

export function useDeleteConnectionProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/connection-profiles/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["connection-profiles"] });
      qc.invalidateQueries({ queryKey: ["services"] });
    },
  });
}

export function useSetFlowProfile(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (profileId: string) =>
      api(`/flows/${packageId}/profile`, {
        method: "PUT",
        body: JSON.stringify({ profileId }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flow"] });
      qc.invalidateQueries({ queryKey: ["services"] });
    },
  });
}

export function useClearFlowProfile(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api(`/flows/${packageId}/profile`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flow"] });
      qc.invalidateQueries({ queryKey: ["services"] });
    },
  });
}
