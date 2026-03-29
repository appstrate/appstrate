import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import { onMutationError } from "./use-mutations";
import type { ConnectionProfile, UserConnectionProviderGroup } from "@appstrate/shared-types";

interface ProfileWithConnections extends ConnectionProfile {
  connectionCount: number;
}

interface ConnectionRecord {
  id: string;
  profileId: string;
  providerId: string;
  orgId: string;
  scopesGranted?: string[];
  createdAt: string;
  updatedAt: string;
}

/** List connections for a specific profile (user or org). */
export function useProfileConnections(profileId: string | null | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["profile-connections", orgId, profileId],
    queryFn: () =>
      api<{ connections: ConnectionRecord[] }>(
        `/connection-profiles/${profileId}/connections`,
      ).then((r) => r.connections),
    enabled: !!profileId,
    staleTime: 30_000,
  });
}

export interface OrgProfileWithBindings extends ConnectionProfile {
  bindingCount: number;
  boundProviderIds: string[];
}

export function useConnectionProfiles() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["connection-profiles", orgId],
    queryFn: () =>
      api<{ profiles: ProfileWithConnections[] }>("/connection-profiles").then((r) => r.profiles),
  });
}

export function useAllUserConnections() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["user-connections", orgId],
    queryFn: () =>
      api<{ providers: UserConnectionProviderGroup[] }>("/connection-profiles/connections"),
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
    onError: onMutationError,
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
    onError: onMutationError,
  });
}

export function useDeleteConnectionProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/connection-profiles/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["connection-profiles"] });
      qc.invalidateQueries({ queryKey: ["available-providers"] });
    },
    onError: onMutationError,
  });
}

// ─── Org Profiles ────────────────────────────────────────

export function useOrgProfiles() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["org-connection-profiles", orgId],
    queryFn: () =>
      api<{ profiles: OrgProfileWithBindings[] }>("/connection-profiles/org").then(
        (r) => r.profiles,
      ),
  });
}

export function useCreateOrgProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api<ConnectionProfile>("/connection-profiles/org", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["org-connection-profiles"] });
    },
    onError: onMutationError,
  });
}

export function useRenameOrgProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api(`/connection-profiles/org/${id}`, {
        method: "PUT",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["org-connection-profiles"] });
    },
    onError: onMutationError,
  });
}

export function useDeleteOrgProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/connection-profiles/org/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["org-connection-profiles"] });
      qc.invalidateQueries({ queryKey: ["available-providers"] });
    },
    onError: onMutationError,
  });
}

export function useMyOrgBindings() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["my-org-bindings", orgId],
    queryFn: () =>
      api<{
        profiles: { profile: ConnectionProfile; providerIds: string[] }[];
      }>("/connection-profiles/my-org-bindings").then((r) => r.profiles),
  });
}

export interface EnrichedBinding {
  providerId: string;
  sourceProfileId: string;
  sourceProfileName: string;
  boundByUserName: string | null;
  connected: boolean;
}

export function useOrgProfileBindings(profileId: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["org-profile-bindings", orgId, profileId],
    queryFn: () =>
      api<{ bindings: EnrichedBinding[] }>(`/connection-profiles/org/${profileId}/bindings`).then(
        (r) => r.bindings,
      ),
    enabled: !!profileId,
    staleTime: 30_000,
  });
}

export function useBindOrgProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      profileId,
      providerId,
      sourceProfileId,
    }: {
      profileId: string;
      providerId: string;
      sourceProfileId: string;
    }) =>
      api(`/connection-profiles/org/${profileId}/bind`, {
        method: "POST",
        body: JSON.stringify({ providerId, sourceProfileId }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["org-profile-bindings"] });
      qc.invalidateQueries({ queryKey: ["org-connection-profiles"] });
      qc.invalidateQueries({ queryKey: ["my-org-bindings"] });
      qc.invalidateQueries({ queryKey: ["packages", "flow"] });
      qc.invalidateQueries({ queryKey: ["flow-provider-profiles"] });
    },
    onError: onMutationError,
  });
}

export function useUnbindOrgProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ profileId, providerId }: { profileId: string; providerId: string }) =>
      api(`/connection-profiles/org/${profileId}/bind/${providerId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["org-profile-bindings"] });
      qc.invalidateQueries({ queryKey: ["org-connection-profiles"] });
      qc.invalidateQueries({ queryKey: ["my-org-bindings"] });
      qc.invalidateQueries({ queryKey: ["packages", "flow"] });
      qc.invalidateQueries({ queryKey: ["flow-provider-profiles"] });
    },
    onError: onMutationError,
  });
}

// ─── Flow Org Profile Override ───────────────────────────

export function useSetFlowOrgProfile(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (orgProfileId: string | null) => {
      return api(`/flows/${packageId}/org-profile`, {
        method: "PUT",
        body: JSON.stringify({ orgProfileId }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["packages", "flow"] });
    },
    onError: onMutationError,
  });
}

// ─── Org Profile Linked Flows ────────────────────────────

export function useOrgProfileFlows(profileId: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["org-profile-flows", orgId, profileId],
    queryFn: () =>
      api<{ flows: { id: string; displayName: string }[] }>(
        `/connection-profiles/org/${profileId}/flows`,
      ).then((r) => r.flows),
    enabled: !!profileId,
    staleTime: 30_000,
  });
}

// ─── Per-Provider Profile Overrides ──────────────────────

export function useFlowProviderProfiles(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["flow-provider-profiles", orgId, packageId],
    queryFn: () =>
      api<{ overrides: Record<string, string> }>(`/flows/${packageId}/provider-profiles`).then(
        (r) => r.overrides,
      ),
    enabled: !!packageId,
    staleTime: 30_000,
  });
}

export function useSetFlowProviderProfile(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ providerId, profileId }: { providerId: string; profileId: string }) => {
      return api(`/flows/${packageId}/provider-profiles`, {
        method: "PUT",
        body: JSON.stringify({ providerId, profileId }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flow-provider-profiles"] });
      qc.invalidateQueries({ queryKey: ["packages", "flow"] });
    },
    onError: onMutationError,
  });
}

export function useRemoveFlowProviderProfile(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (providerId: string) => {
      return api(`/flows/${packageId}/provider-profiles`, {
        method: "DELETE",
        body: JSON.stringify({ providerId }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flow-provider-profiles"] });
      qc.invalidateQueries({ queryKey: ["packages", "flow"] });
    },
    onError: onMutationError,
  });
}
