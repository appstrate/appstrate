// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound } from "lucide-react";
import { useOrgSettings } from "../../hooks/use-org-settings";
import { EmptyState, ErrorState } from "../../components/page-states";
import { TextSkeleton } from "../../components/loading-skeletons";
import { SettingsGroup } from "../../components/settings/setting-row";
import { OrgSettingToggle } from "../../components/settings/org-setting-toggle";

const loadOAuthClientsTab = () => import("../../modules/oidc/components/oauth-clients-tab");

const OAuthClientsTab = lazy(() =>
  loadOAuthClientsTab().then((m) => ({
    default: m.OAuthClientsTab,
  })),
);

export function OrgSettingsOAuthPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { data: orgSettings, isLoading, failureReason } = useOrgSettings();
  // Switching collaborator SSO is `org:settings` (enforced by the toggle, as the API requires);
  // reading the clients below stays open to whoever reached the page.

  // The chunk loads alongside the settings read instead of after it; the module is cached, so the
  // lazy import below resolves at once.
  useEffect(() => {
    void loadOAuthClientsTab();
  }, []);

  if (failureReason) return <ErrorState error={failureReason} />;

  return (
    <>
      <SettingsGroup>
        <OrgSettingToggle
          id="dashboard-sso"
          field="dashboard_sso_enabled"
          label={t("orgSettings.dashboardSsoEnable")}
          description={t("orgSettings.dashboardSsoDesc")}
        />
      </SettingsGroup>

      {isLoading ? (
        <TextSkeleton lines={4} />
      ) : orgSettings?.dashboard_sso_enabled ? (
        <Suspense fallback={<TextSkeleton lines={4} />}>
          <OAuthClientsTab level="org" />
        </Suspense>
      ) : (
        <EmptyState
          compact
          icon={KeyRound}
          message={t("orgSettings.dashboardSsoDisabledTitle")}
          hint={t("orgSettings.dashboardSsoDisabledDesc")}
        />
      )}
    </>
  );
}
