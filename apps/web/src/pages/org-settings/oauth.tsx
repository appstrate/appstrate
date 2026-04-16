// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense } from "react";
import { Navigate } from "react-router-dom";
import { usePermissions } from "../../hooks/use-permissions";
import { useAppConfig } from "../../hooks/use-app-config";
import { useOrgSettings } from "../../hooks/use-org-settings";
import { LoadingState } from "../../components/page-states";

const OAuthClientsTab = lazy(() =>
  import("../../modules/oidc/components/oauth-clients-tab").then((m) => ({
    default: m.OAuthClientsTab,
  })),
);

export function OrgSettingsOAuthPage() {
  const { isAdmin } = usePermissions();
  const { features } = useAppConfig();
  const { data: orgSettings, isLoading } = useOrgSettings();

  if (!isAdmin || !features.oidc) {
    return <Navigate to="/org-settings/general" replace />;
  }

  if (isLoading) return <LoadingState />;

  if (!orgSettings?.dashboardSsoEnabled) {
    return <Navigate to="/org-settings/general" replace />;
  }

  return (
    <Suspense fallback={<LoadingState />}>
      <OAuthClientsTab level="org" />
    </Suspense>
  );
}
