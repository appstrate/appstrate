// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { AppWindow } from "lucide-react";
import { usePermissions } from "../../../hooks/use-permissions";
import { useCurrentApplicationId } from "../../../hooks/use-current-application";
import { EmptyState } from "../../../components/page-states";
import { AppProfilesTab } from "../../../components/app-profiles-tab";

export function OrgSettingsAppProfilesPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();
  const appId = useCurrentApplicationId();

  if (!isAdmin) return null;
  if (!appId) return <EmptyState message={t("applications.noAppSelected")} icon={AppWindow} />;

  return <AppProfilesTab />;
}
