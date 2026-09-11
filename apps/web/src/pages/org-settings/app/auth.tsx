// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense } from "react";
import { usePermissions } from "../../../hooks/use-permissions";
import { useAppConfig } from "../../../hooks/use-app-config";
import { useCurrentSpaceId } from "../../../hooks/use-current-space";
import { LoadingState } from "../../../components/page-states";
import { NavigateKeepingState } from "../../../components/navigate-keeping-state";

const SpaceAuthTab = lazy(() =>
  import("../../../modules/oidc/components/space-auth-tab").then((m) => ({
    default: m.SpaceAuthTab,
  })),
);

export function OrgSettingsAppAuthPage() {
  const { can } = usePermissions();
  const { features } = useAppConfig();
  const spaceId = useCurrentSpaceId();

  if (!can("space:update") || !spaceId || !features.oidc) {
    return <NavigateKeepingState to="/workspace-settings/general" />;
  }

  return (
    <Suspense fallback={<LoadingState />}>
      <SpaceAuthTab />
    </Suspense>
  );
}
