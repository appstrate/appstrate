// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense } from "react";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { LoadingState } from "../../components/page-states";
import { UnavailableState } from "../../components/route-gate";

const OAuthClientsTab = lazy(() =>
  import("../../modules/oidc/components/oauth-clients-tab").then((m) => ({
    default: m.OAuthClientsTab,
  })),
);

export function WorkspaceSettingsOAuthPage() {
  const spaceId = useCurrentSpaceId();

  if (!spaceId) return <UnavailableState />;

  return (
    <Suspense fallback={<LoadingState />}>
      <OAuthClientsTab level="space" />
    </Suspense>
  );
}
