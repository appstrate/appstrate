// SPDX-License-Identifier: Apache-2.0

import {
  useConnect,
  useConnectApiKey,
  useConnectCredentials,
  useDisconnect,
} from "./use-mutations";
import {
  useConnectionProfiles,
  useProfileConnections,
  useOrgProfileBindings,
  useBindOrgProvider,
  useUnbindOrgProvider,
  useFlowProviderProfiles,
  useSetFlowProviderProfile,
} from "./use-connection-profiles";
import { isProviderConnectedInProfile } from "../lib/provider-status";

interface UseProviderConnectionParams {
  providerId: string;
  packageId?: string;
  orgProfileId?: string;
  readOnly?: boolean;
  /** Override the profile used to check connection status (e.g. schedule owner's profile) */
  viewProfileId?: string;
}

export function useProviderConnection({
  providerId,
  packageId,
  orgProfileId,
  readOnly: readOnlyParam,
  viewProfileId,
}: UseProviderConnectionParams) {
  // User profiles
  const { data: userProfiles } = useConnectionProfiles();
  const defaultProfile = userProfiles?.find((p) => p.isDefault);
  const hasMultipleProfiles = (userProfiles?.length ?? 0) > 1;

  // Per-provider profile override (persisted via API when packageId is provided)
  const { data: providerOverrides } = useFlowProviderProfiles(packageId);
  const setProviderProfile = useSetFlowProviderProfile(packageId ?? "");
  const overrideProfileId = providerOverrides?.[providerId];
  const effectiveProfileId = overrideProfileId ?? defaultProfile?.id ?? null;

  // Connection status — use viewProfileId when viewing another user's profile (read-only)
  const statusProfileId = viewProfileId ?? effectiveProfileId;
  const { data: profileConnections } = useProfileConnections(statusProfileId);
  const isConnected = isProviderConnectedInProfile(providerId, profileConnections);

  // Binding status (only when orgProfileId is provided)
  const { data: bindings } = useOrgProfileBindings(orgProfileId);
  const binding = bindings?.find((b) => b.providerId === providerId);
  const isBound = !!binding;
  const isBoundButDisconnected = isBound && binding?.connected === false;
  const isEffectivelyBound = isBound && !isBoundButDisconnected;

  // Mutations
  const connectMutation = useConnect();
  const connectApiKeyMutation = useConnectApiKey();
  const connectCredentialsMutation = useConnectCredentials();
  const disconnectMutation = useDisconnect();
  const bindMutation = useBindOrgProvider();
  const unbindMutation = useUnbindOrgProvider();

  const isPending =
    connectMutation.isPending ||
    connectApiKeyMutation.isPending ||
    connectCredentialsMutation.isPending ||
    disconnectMutation.isPending ||
    bindMutation.isPending ||
    unbindMutation.isPending;

  const profileParam = effectiveProfileId ? { profileId: effectiveProfileId } : {};

  const handleProfileChange = (profileId: string) => {
    if (packageId) {
      setProviderProfile.mutate({ providerId, profileId });
    }
  };

  const doBind = () => {
    if (!orgProfileId || !effectiveProfileId) return;
    bindMutation.mutate({
      profileId: orgProfileId,
      providerId,
      sourceProfileId: effectiveProfileId,
    });
  };

  const handleUnbind = () => {
    if (!orgProfileId) return;
    unbindMutation.mutate({ profileId: orgProfileId, providerId });
  };

  return {
    userProfiles,
    hasMultipleProfiles,
    effectiveProfileId,
    overrideProfileId,
    isConnected,
    profileConnections,
    binding,
    isBound,
    isBoundButDisconnected,
    isEffectivelyBound,
    connectMutation,
    connectApiKeyMutation,
    connectCredentialsMutation,
    disconnectMutation,
    isPending,
    profileParam,
    handleProfileChange,
    doBind,
    handleUnbind,
    readOnly: readOnlyParam ?? false,
  };
}
