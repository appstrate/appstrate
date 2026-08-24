// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense } from "react";
import { usePermissions } from "../../../hooks/use-permissions";
import { useAppConfig } from "../../../hooks/use-app-config";
import { useCurrentApplicationId } from "../../../hooks/use-current-application";
import { LoadingState } from "../../../components/page-states";
import { NavigateKeepingState } from "../../../components/navigate-keeping-state";

const OAuthClientsTab = lazy(() =>
  import("../../../modules/oidc/components/oauth-clients-tab").then((m) => ({
    default: m.OAuthClientsTab,
  })),
);

export function OrgSettingsAppOauthPage() {
  const { isAdmin } = usePermissions();
  const { features } = useAppConfig();
  const applicationId = useCurrentApplicationId();

  if (!isAdmin || !applicationId || !features.oidc) {
    return <NavigateKeepingState to="/workspace-settings/general" />;
  }

  return (
    <Suspense fallback={<LoadingState />}>
      <OAuthClientsTab level="application" />
    </Suspense>
  );
}
