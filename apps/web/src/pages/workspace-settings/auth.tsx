// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense } from "react";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { SettingsSkeleton } from "../../components/loading-skeletons";
import { UnavailableState } from "../../components/route-gate";

const SpaceAuthTab = lazy(() =>
  import("../../modules/oidc/components/space-auth-tab").then((m) => ({
    default: m.SpaceAuthTab,
  })),
);

export function WorkspaceSettingsAuthPage() {
  const spaceId = useCurrentSpaceId();

  if (!spaceId) return <UnavailableState />;

  return (
    <Suspense fallback={<SettingsSkeleton />}>
      <SpaceAuthTab />
    </Suspense>
  );
}
