// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
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

/**
 * List connections for a specific profile (user or org).
 *
 * Connections are scoped to the current application via X-App-Id header:
 * the backend filters by providerCredentialId matching the app's configured
 * credentials. Connection profiles themselves are app-independent — connections
 * from different apps accumulate on the same profile, but this hook only
 * returns the current app's connections.
 */
export function useProfileConnections(profileId: string | null | undefined) {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["profile-connections", orgId, appId, profileId],
    queryFn: () =>
      api<{ connections: ConnectionInfo[] }>(`/app-profiles/${profileId}/connections`).then(
        (r) => r.connections,
      ),
    enabled: !!profileId && !!appId,
    staleTime: 30_000,
  });
}

interface AppProfileWithBindings extends ConnectionProfile {
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
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["user-connections", orgId, appId],
    queryFn: () => api<{ providers: UserConnectionProviderGroup[] }>("/app-profiles/connections"),
    enabled: !!appId,
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

// ─── App Profiles ────────────────────────────────────────

export function useAppProfiles() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["app-connection-profiles", orgId],
    queryFn: () =>
      api<{ profiles: AppProfileWithBindings[] }>("/app-profiles").then((r) => r.profiles),
  });
}

const appProfileMutations = createProfileMutations("/app-profiles", "app-connection-profiles");
export const useCreateAppProfile = appProfileMutations.useCreate;
export const useRenameAppProfile = appProfileMutations.useRename;
export const useDeleteAppProfile = appProfileMutations.useDelete;

export function useAppProfileBindings(profileId: string | undefined) {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["app-profile-bindings", orgId, appId, profileId],
    queryFn: () =>
      api<{ bindings: EnrichedBinding[] }>(`/app-profiles/${profileId}/bindings`).then(
        (r) => r.bindings,
      ),
    enabled: !!profileId,
    staleTime: 30_000,
  });
}

export function useBindAppProvider() {
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
      api(`/app-profiles/${profileId}/bind`, {
        method: "POST",
        body: JSON.stringify({ providerId, sourceProfileId }),
      }),
    onSuccess: () => invalidateConnectionRelated(qc),
    onError: onMutationError,
  });
}

export function useUnbindAppProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ profileId, providerId }: { profileId: string; providerId: string }) =>
      api(`/app-profiles/${profileId}/bind/${providerId}`, {
        method: "DELETE",
      }),
    onSuccess: () => invalidateConnectionRelated(qc),
    onError: onMutationError,
  });
}

// ─── Agent App Profile Override ───────────────────────────

export function useSetAgentAppProfile(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (appProfileId: string | null) => {
      return api(`/agents/${packageId}/app-profile`, {
        method: "PUT",
        body: JSON.stringify({ appProfileId }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["packages", "agent"] });
      qc.invalidateQueries({ queryKey: ["agent-provider-profiles"] });
    },
    onError: onMutationError,
  });
}

// ─── App Profile Linked Agents ────────────────────────────

export function useAppProfileAgents(profileId: string | undefined) {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["app-profile-agents", orgId, appId, profileId],
    queryFn: () =>
      api<{ agents: { id: string; displayName: string }[] }>(
        `/app-profiles/${profileId}/agents`,
      ).then((r) => r.agents),
    enabled: !!profileId,
    staleTime: 30_000,
  });
}

// ─── Per-Provider Profile Overrides ──────────────────────

export function useAgentProviderProfiles(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["agent-provider-profiles", orgId, appId, packageId],
    queryFn: () =>
      api<{ overrides: Record<string, string> }>(`/agents/${packageId}/provider-profiles`).then(
        (r) => r.overrides,
      ),
    enabled: !!orgId && !!appId && !!packageId,
    staleTime: 30_000,
  });
}

export function useSetAgentProviderProfile(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ providerId, profileId }: { providerId: string; profileId: string }) => {
      return api(`/agents/${packageId}/provider-profiles`, {
        method: "PUT",
        body: JSON.stringify({ providerId, profileId }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent-provider-profiles"] });
      qc.invalidateQueries({ queryKey: ["packages", "agent"] });
    },
    onError: onMutationError,
  });
}
