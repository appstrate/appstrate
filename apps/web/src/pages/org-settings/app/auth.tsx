// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense } from "react";
import { usePermissions } from "../../../hooks/use-permissions";
import { useAppConfig } from "../../../hooks/use-app-config";
import { useCurrentApplicationId } from "../../../hooks/use-current-application";
import { LoadingState } from "../../../components/page-states";
import { NavigateKeepingState } from "../../../components/navigate-keeping-state";

const AppAuthTab = lazy(() =>
  import("../../../modules/oidc/components/app-auth-tab").then((m) => ({
    default: m.AppAuthTab,
  })),
);

export function OrgSettingsAppAuthPage() {
  const { isAdmin } = usePermissions();
  const { features } = useAppConfig();
  const applicationId = useCurrentApplicationId();

  if (!isAdmin || !applicationId || !features.oidc) {
    return <NavigateKeepingState to="/workspace-settings/general" />;
  }

  return (
    <Suspense fallback={<LoadingState />}>
      <AppAuthTab />
    </Suspense>
  );
}
