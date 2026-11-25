// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { SettingRow } from "./setting-row";
import { SaveFeedback } from "./save-feedback";
import { SpaceRoleSelect } from "../space-role-select";
import { useOrg } from "../../hooks/use-org";
import { useOrgSettings, useUpdateOrgSettings } from "../../hooks/use-org-settings";
import { usePermissions } from "../../hooks/use-permissions";
import { useSpaceRoleOptions } from "../../hooks/use-roles";
import { fieldWriteState } from "../../lib/field-write-state";
import { invalidatePackageCaches, invalidatePaths } from "../../lib/query-keys";
import { orgPersonalSpaceRoleBody, storedRoleToSelectValue } from "../../lib/personal-space-role";
import { DisabledReasonTooltip } from "../disabled-reason-tooltip";

/** The role every member holds in their own personal space: a preset or one of the org's custom roles. */
export function PersonalSpaceRoleSetting() {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const { currentOrg } = useOrg();
  const { can } = usePermissions();
  const { data: orgSettings, isLoading } = useOrgSettings();
  const { options, isLoading: rolesLoading } = useSpaceRoleOptions();
  const update = useUpdateOrgSettings();
  if (!currentOrg) return null;
  const mayWrite = can("org:settings");
  const value = storedRoleToSelectValue(orgSettings?.personal_space_role);

  return (
    <SettingRow
      label={t("orgSettings.personalSpaceRoleTitle")}
      description={t("orgSettings.personalSpaceRoleDesc")}
      status={<SaveFeedback {...fieldWriteState(update, "personal_space_role")} />}
    >
      {(labelId) => (
        <DisabledReasonTooltip reason={mayWrite ? null : t("orgSettings.cannotChange")}>
          <SpaceRoleSelect
            id="personal-space-role"
            ariaLabelledBy={labelId}
            className="w-full sm:w-[240px]"
            value={value}
            options={options}
            fallbackLabel={t("orgSettings.personalSpaceRoleUnknown")}
            loading={isLoading || rolesLoading}
            disabled={!mayWrite || !orgSettings || update.isPending}
            onValueChange={(next) =>
              update.mutate(
                {
                  params: { path: { orgId: currentOrg.id } },
                  body: orgPersonalSpaceRoleBody(next),
                },
                {
                  // The role changes the permissions each space serves and the verdicts carried by package rows.
                  onSuccess: () => {
                    void invalidatePaths(queryClient, ["/api/spaces", "/api/spaces/{id}"]);
                    invalidatePackageCaches(queryClient);
                  },
                },
              )
            }
          />
        </DisabledReasonTooltip>
      )}
    </SettingRow>
  );
}
