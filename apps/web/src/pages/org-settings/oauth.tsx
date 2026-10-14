// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound } from "lucide-react";
import { Switch } from "@appstrate/ui/components/switch";
import { Label } from "@appstrate/ui/components/label";
import { useOrgSettings, useUpdateOrgSettings } from "../../hooks/use-org-settings";
import { useOrg } from "../../hooks/use-org";
import { usePermissions } from "../../hooks/use-permissions";
import { EmptyState, ErrorState, LoadingState } from "../../components/page-states";
import { SettingsGroup, SettingRow } from "../../components/settings/setting-row";
import { SaveFeedback } from "../../components/settings/save-feedback";

const OAuthClientsTab = lazy(() =>
  import("../../modules/oidc/components/oauth-clients-tab").then((m) => ({
    default: m.OAuthClientsTab,
  })),
);

export function OrgSettingsOAuthPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { data: orgSettings, isLoading, failureReason } = useOrgSettings();
  const updateSettingsMutation = useUpdateOrgSettings();
  const { currentOrg } = useOrg();
  // Switching collaborator SSO is `org:settings`, as the API requires; reading
  // the clients below stays open to whoever reached the page.
  const { can } = usePermissions();

  if (failureReason) return <ErrorState error={failureReason} />;
  if (isLoading) return <LoadingState />;

  return (
    <>
      <SettingsGroup>
        <SettingRow
          variant="toggle"
          label={
            <Label htmlFor="dashboard-sso" className="cursor-pointer">
              {t("orgSettings.dashboardSsoEnable")}
            </Label>
          }
          description={t("orgSettings.dashboardSsoDesc")}
          status={
            <SaveFeedback
              pending={updateSettingsMutation.isPending}
              success={updateSettingsMutation.isSuccess}
              error={updateSettingsMutation.isError}
            />
          }
        >
          <Switch
            id="dashboard-sso"
            checked={orgSettings?.dashboard_sso_enabled ?? false}
            disabled={!currentOrg || !can("org:settings") || updateSettingsMutation.isPending}
            onCheckedChange={(checked) => {
              if (!currentOrg) return;
              // A refusal is said once, by the global mutation toast.
              updateSettingsMutation.mutate({
                params: { path: { orgId: currentOrg.id } },
                body: { dashboard_sso_enabled: checked === true },
              });
            }}
          />
        </SettingRow>
      </SettingsGroup>

      {orgSettings?.dashboard_sso_enabled ? (
        <Suspense fallback={<LoadingState />}>
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
