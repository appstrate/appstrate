// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { OrgSettingToggle } from "./org-setting-toggle";
import { invalidatePackageCaches, invalidatePaths } from "../../lib/query-keys";

/** ON keeps today's default: a member is `admin` of their personal space; OFF caps them to `operator`. */
export function PersonalSpaceRoleSetting() {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  return (
    <OrgSettingToggle
      id="personal-space-role"
      field="personal_space_role"
      label={t("orgSettings.personalSpaceRoleTitle")}
      description={t("orgSettings.personalSpaceRoleDesc")}
      // The cap changes the permissions each space serves and the verdicts carried by package rows.
      onSuccess={() => {
        void invalidatePaths(queryClient, ["/api/spaces", "/api/spaces/{id}"]);
        invalidatePackageCaches(queryClient);
      }}
    />
  );
}
