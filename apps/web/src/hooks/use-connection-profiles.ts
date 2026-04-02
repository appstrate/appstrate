// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import { onMutationError } from "./use-mutations";
import { invalidateConnectionRelated } from "./invalidation";
import type {
  ConnectionProfile,
  ConnectionInfo,
  UserConnectionProviderGroup,
  EnrichedBinding,
} from "@appstrate/shared-types";

interface ProfileWithConnections extends ConnectionProfile {
  connectionCount: number;
}

/** List connections for a specific profile (user or org). */
export function useProfileConnections(profileId: string | null | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["profile-connections", orgId, profileId],
    queryFn: () =>
      api<{ connections: ConnectionInfo[] }>(`/connection-profiles/${profileId}/connections`).then(
        (r) => r.connections,
      ),
    enabled: !!profileId,
    staleTime: 30_000,
  });
}

interface OrgProfileWithBindings extends ConnectionProfile {
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

// ─── Shared Profile CRUD Factory ─────────────────────────

function createProfileMutations(basePath: string, queryKey: string) {
  const useCreate = () => {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: (name: string) =>
        api<ConnectionProfile>(basePath, {
          method: "POST",
          body: JSON.stringify({ name }),
        }),
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: [queryKey] });
      },
      onError: onMutationError,
    });
  };

  const useRename = () => {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: ({ id, name }: { id: string; name: string }) =>
        api(`${basePath}/${id}`, {
          method: "PUT",
          body: JSON.stringify({ name }),
        }),
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: [queryKey] });
      },
      onError: onMutationError,
    });
  };

  const useDelete = () => {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: (id: string) => api(`${basePath}/${id}`, { method: "DELETE" }),
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: [queryKey] });
        qc.invalidateQueries({ queryKey: ["available-providers"] });
      },
      onError: onMutationError,
    });
  };

  return { useCreate, useRename, useDelete };
}

const userProfileMutations = createProfileMutations("/connection-profiles", "connection-profiles");
export const useCreateConnectionProfile = userProfileMutations.useCreate;
export const useRenameConnectionProfile = userProfileMutations.useRename;
export const useDeleteConnectionProfile = userProfileMutations.useDelete;

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

const orgProfileMutations = createProfileMutations(
  "/connection-profiles/org",
  "org-connection-profiles",
);
export const useCreateOrgProfile = orgProfileMutations.useCreate;
export const useRenameOrgProfile = orgProfileMutations.useRename;
export const useDeleteOrgProfile = orgProfileMutations.useDelete;

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
    onSuccess: () => invalidateConnectionRelated(qc),
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
    onSuccess: () => invalidateConnectionRelated(qc),
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
      qc.invalidateQueries({ queryKey: ["flow-provider-profiles"] });
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
