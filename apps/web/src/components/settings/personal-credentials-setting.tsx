// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Label } from "@appstrate/ui/components/label";
import { Switch } from "@appstrate/ui/components/switch";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { SettingRow } from "./setting-row";
import { SaveFeedback } from "./save-feedback";
import { useOrg } from "../../hooks/use-org";
import { useOrgSettings, useUpdateOrgSettings } from "../../hooks/use-org-settings";
import { usePermissions } from "../../hooks/use-permissions";

/**
 * « Members can use their personal key or subscription »: the organization's
 * `personal_model_credentials`. One switch, written in one place, shown where the models are
 * (Settings › Models) and in General.
 */
export function PersonalCredentialsSetting() {
  const { t } = useTranslation("settings");
  const { currentOrg } = useOrg();
  const { can } = usePermissions();
  const { data: orgSettings, isLoading: orgSettingsLoading } = useOrgSettings();
  const update = useUpdateOrgSettings();
  const queryClient = useQueryClient();
  if (!currentOrg) return null;

  // A skeleton stands in until the settings load, so a click can never send a value read off a
  // default.
  return (
    <SettingRow
      variant="toggle"
      label={
        <Label htmlFor="personal-model-credentials" className="cursor-pointer">
          {t("orgSettings.personalModelCredentialsTitle")}
        </Label>
      }
      description={t("orgSettings.personalModelCredentialsDesc")}
      status={
        <SaveFeedback
          pending={update.isPending}
          success={update.isSuccess}
          error={update.isError}
        />
      }
    >
      {!orgSettingsLoading ? (
        <Switch
          id="personal-model-credentials"
          checked={orgSettings?.personal_model_credentials ?? false}
          disabled={!can("org:settings") || update.isPending || !orgSettings}
          onCheckedChange={(checked) =>
            update.mutate(
              {
                params: { path: { orgId: currentOrg.id } },
                body: { personal_model_credentials: checked === true },
              },
              {
                // The flag changes which models each person can use and which credentials
                // serve a call: refresh both lists.
                onSuccess: () => {
                  void queryClient.invalidateQueries({ queryKey: ["get", "/api/models"] });
                  void queryClient.invalidateQueries({
                    queryKey: ["get", "/api/model-provider-credentials"],
                  });
                },
              },
            )
          }
        />
      ) : (
        <Skeleton className="h-5 w-9 rounded-full" />
      )}
    </SettingRow>
  );
}
