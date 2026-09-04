// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense } from "react";
import { Navigate } from "react-router-dom";
import { usePermissions } from "../../../hooks/use-permissions";
import { useAppConfig } from "../../../hooks/use-app-config";
import { useCurrentSpaceId } from "../../../hooks/use-current-space";
import { LoadingState } from "../../../components/page-states";

const SpaceAuthTab = lazy(() =>
  import("../../../modules/oidc/components/space-auth-tab").then((m) => ({
    default: m.SpaceAuthTab,
  })),
);

export function OrgSettingsSpaceAuthPage() {
  const { can } = usePermissions();
  const { features } = useAppConfig();
  const spaceId = useCurrentSpaceId();

  if (!can("spaces:write") || !spaceId || !features.oidc) {
    return <Navigate to="/org-settings/space/general" replace />;
  }

  return (
    <Suspense fallback={<LoadingState />}>
      <SpaceAuthTab />
    </Suspense>
  );
}
