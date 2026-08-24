// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound } from "lucide-react";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Label } from "@appstrate/ui/components/label";
import { getErrorMessage } from "@appstrate/core/errors";
import { toast } from "sonner";
import { usePermissions } from "../../hooks/use-permissions";
import { useAppConfig } from "../../hooks/use-app-config";
import { useOrgSettings, useUpdateOrgSettings } from "../../hooks/use-org-settings";
import { useOrg } from "../../hooks/use-org";
import { EmptyState, ErrorState, LoadingState } from "../../components/page-states";
import { SettingsGroup, SettingRow } from "../../components/settings/setting-row";
import { Spinner } from "../../components/spinner";
import { NavigateKeepingState } from "../../components/navigate-keeping-state";

const OAuthClientsTab = lazy(() =>
  import("../../modules/oidc/components/oauth-clients-tab").then((m) => ({
    default: m.OAuthClientsTab,
  })),
);

export function OrgSettingsOAuthPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();
  const { features } = useAppConfig();
  const { data: orgSettings, isLoading, failureReason } = useOrgSettings();
  const updateSettingsMutation = useUpdateOrgSettings();
  const { currentOrg } = useOrg();

  if (!isAdmin || !features.oidc) {
    return <NavigateKeepingState to="/org-settings/general" />;
  }

  if (failureReason) return <ErrorState message={getErrorMessage(failureReason)} />;
  if (isLoading) return <LoadingState />;

  return (
    <>
      <SettingsGroup title={t("orgSettings.dashboardSsoTitle")}>
        <SettingRow
          variant="toggle"
          label={
            <Label htmlFor="dashboard-sso" className="cursor-pointer">
              {t("orgSettings.dashboardSsoEnable")}
            </Label>
          }
          description={t("orgSettings.dashboardSsoDesc")}
          status={updateSettingsMutation.isPending && <Spinner />}
        >
          <Checkbox
            id="dashboard-sso"
            checked={orgSettings?.dashboard_sso_enabled ?? false}
            disabled={!currentOrg || updateSettingsMutation.isPending}
            onCheckedChange={(checked) => {
              if (!currentOrg) return;
              updateSettingsMutation.mutate(
                {
                  params: { path: { orgId: currentOrg.id } },
                  body: { dashboard_sso_enabled: checked === true },
                },
                {
                  onError: (error) =>
                    toast.error(t("error.prefix", { message: getErrorMessage(error) })),
                },
              );
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
