// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense } from "react";
import { Navigate } from "react-router-dom";
import { usePermissions } from "../../../hooks/use-permissions";
import { useAppConfig } from "../../../hooks/use-app-config";
import { useCurrentApplicationId } from "../../../hooks/use-current-application";
import { LoadingState } from "../../../components/page-states";

const AppAuthTab = lazy(() =>
  import("../../../modules/oidc/components/app-auth-tab").then((m) => ({
    default: m.AppAuthTab,
  })),
);

export function OrgSettingsAppAuthPage() {
  const { isAdmin } = usePermissions();
  const { features } = useAppConfig();
  const appId = useCurrentApplicationId();

  if (!isAdmin || !appId || !features.oidc) {
    return <Navigate to="/org-settings/app/general" replace />;
  }

  return (
    <Suspense fallback={<LoadingState />}>
      <AppAuthTab />
    </Suspense>
  );
}
