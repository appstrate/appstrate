import { usePackageDetail } from "./use-packages";
import { useProfileConnections, useOrgProfileBindings } from "./use-connection-profiles";
import { isProviderConnectedInProfile } from "../lib/provider-status";

interface ScheduleReadinessInput {
  packageId: string;
  connectionProfileId: string;
  profileType: "user" | "org" | null;
}

export function useScheduleProviderReadiness(schedule: ScheduleReadinessInput | undefined) {
  const isOrgProfile = schedule?.profileType === "org";
  const orgProfileId = isOrgProfile ? schedule?.connectionProfileId : undefined;

  const { data: flowDetail, isLoading: isLoadingFlow } = usePackageDetail(
    "flow",
    schedule?.packageId,
  );
  const { data: profileConnections, isLoading: isLoadingConnections } = useProfileConnections(
    isOrgProfile ? undefined : schedule?.connectionProfileId,
  );
  const { data: bindings, isLoading: isLoadingBindings } = useOrgProfileBindings(orgProfileId);

  const flowProviders: string[] =
    flowDetail?.dependencies?.providers?.map((p: { id: string }) => p.id) ?? [];

  // Still loading if the flow detail or the relevant connection data hasn't arrived
  const isLoading = isLoadingFlow || (isOrgProfile ? isLoadingBindings : isLoadingConnections);

  let connectedCount = 0;
  for (const pid of flowProviders) {
    if (isOrgProfile) {
      if (bindings?.find((b) => b.providerId === pid && b.connected)) connectedCount++;
    } else {
      if (isProviderConnectedInProfile(pid, profileConnections)) connectedCount++;
    }
  }

  const totalProviders = flowProviders.length;
  const allReady = totalProviders === 0 || connectedCount === totalProviders;

  return { totalProviders, connectedCount, allReady, flowProviders, isLoading };
}
