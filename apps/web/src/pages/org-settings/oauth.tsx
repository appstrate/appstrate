// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound } from "lucide-react";
import { Switch } from "@appstrate/ui/components/switch";
import { Label } from "@appstrate/ui/components/label";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { useOrgSettings, useUpdateOrgSettings } from "../../hooks/use-org-settings";
import { useOrg } from "../../hooks/use-org";
import { usePermissions } from "../../hooks/use-permissions";
import { EmptyState, ErrorState } from "../../components/page-states";
import { TextSkeleton } from "../../components/loading-skeletons";
import { SettingsGroup, SettingRow } from "../../components/settings/setting-row";
import { SaveFeedback } from "../../components/settings/save-feedback";

const loadOAuthClientsTab = () => import("../../modules/oidc/components/oauth-clients-tab");

const OAuthClientsTab = lazy(() =>
  loadOAuthClientsTab().then((m) => ({
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

  // The chunk loads alongside the settings read instead of after it; the module is cached, so the
  // lazy import below resolves at once.
  useEffect(() => {
    void loadOAuthClientsTab();
  }, []);

  if (failureReason) return <ErrorState error={failureReason} />;

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
          {orgSettings ? (
            <Switch
              id="dashboard-sso"
              checked={orgSettings.dashboard_sso_enabled}
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
          ) : (
            <Skeleton className="h-5 w-9 rounded-full" />
          )}
        </SettingRow>
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
