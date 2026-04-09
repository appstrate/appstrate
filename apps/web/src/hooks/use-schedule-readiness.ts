// SPDX-License-Identifier: Apache-2.0

import { usePackageDetail } from "./use-packages";
import { useProfileConnections, useAppProfileBindings } from "./use-connection-profiles";
import { isProviderConnectedInProfile } from "../lib/provider-status";

interface ScheduleReadinessInput {
  packageId: string;
  connectionProfileId: string;
  profileType: "user" | "app" | null;
}

export function useScheduleProviderReadiness(schedule: ScheduleReadinessInput | undefined) {
  const isAppProfile = schedule?.profileType === "app";
  const appProfileId = isAppProfile ? schedule?.connectionProfileId : undefined;

  const { data: agentDetail, isLoading: isLoadingAgent } = usePackageDetail(
    "agent",
    schedule?.packageId,
  );
  const { data: profileConnections, isLoading: isLoadingConnections } = useProfileConnections(
    isAppProfile ? undefined : schedule?.connectionProfileId,
  );
  const { data: bindings, isLoading: isLoadingBindings } = useAppProfileBindings(appProfileId);

  const agentProviders: string[] =
    agentDetail?.dependencies?.providers?.map((p: { id: string }) => p.id) ?? [];

  // Still loading if the agent detail or the relevant connection data hasn't arrived
  const isLoading = isLoadingAgent || (isAppProfile ? isLoadingBindings : isLoadingConnections);

  let connectedCount = 0;
  for (const pid of agentProviders) {
    if (isAppProfile) {
      if (bindings?.find((b) => b.providerId === pid && b.connected)) connectedCount++;
    } else {
      if (isProviderConnectedInProfile(pid, profileConnections)) connectedCount++;
    }
  }

  const totalProviders = agentProviders.length;
  const allReady = totalProviders === 0 || connectedCount === totalProviders;

  return { totalProviders, connectedCount, allReady, agentProviders, isLoading };
}
