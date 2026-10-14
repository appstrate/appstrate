// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense } from "react";
import { usePermissions } from "../../hooks/use-permissions";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { SettingsSkeleton } from "../../components/loading-skeletons";
import { NoAccessState, UnavailableState } from "../../components/route-gate";

const SpaceAuthTab = lazy(() =>
  import("../../modules/oidc/components/space-auth-tab").then((m) => ({
    default: m.SpaceAuthTab,
  })),
);

export function WorkspaceSettingsAuthPage() {
  const { can } = usePermissions();
  const spaceId = useCurrentSpaceId();

  if (!spaceId) return <UnavailableState />;
  if (!can("space-settings:write")) return <NoAccessState />;

  return (
    <Suspense fallback={<SettingsSkeleton />}>
      <SpaceAuthTab />
    </Suspense>
  );
}
