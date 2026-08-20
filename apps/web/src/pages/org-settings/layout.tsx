// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import {
  BrainCircuit,
  Building,
  CreditCard,
  Globe,
  KeyRound,
  Laptop,
  LayoutGrid,
  Users,
} from "lucide-react";
import { SettingsLayout, type SettingsSection } from "../../components/settings-layout";
import { useOrg } from "../../hooks/use-org";
import { usePermissions } from "../../hooks/use-permissions";
import { useAppConfig } from "../../hooks/use-app-config";
import { useOrgSettings } from "../../hooks/use-org-settings";

export function OrgSettingsLayout() {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();
  const { currentOrg } = useOrg();
  const { features } = useAppConfig();

  const oidcEnabled = !!features.oidc;
  const { data: orgSettings } = useOrgSettings();
  const dashboardSsoEnabled = !!orgSettings?.dashboard_sso_enabled;

  const sections: SettingsSection[] = [
    {
      label: t("orgSettings.sectionOrganization"),
      items: [
        { to: "/org-settings/general", icon: Building, label: t("orgSettings.tabGeneral") },
        {
          to: "/org-settings/members",
          icon: Users,
          label: t("orgSettings.tabMembers", { count: 0 }),
        },
        {
          to: "/org-settings/applications",
          icon: LayoutGrid,
          label: t("applications.pageTitle"),
        },
        {
          to: "/org-settings/models",
          icon: BrainCircuit,
          label: t("models.tabTitle"),
          show: isAdmin,
        },
        {
          to: "/org-settings/proxies",
          icon: Globe,
          label: t("proxies.tabTitle"),
          show: isAdmin,
        },
        {
          to: "/org-settings/oauth",
          icon: KeyRound,
          label: t("orgSettings.tabOauth"),
          show: isAdmin && oidcEnabled && dashboardSsoEnabled,
        },
        // CLI sessions oversight (issue #251 Phase 3) — admin only and
        // gated on the OIDC module being loaded (the backing endpoints
        // live in `apps/api/src/modules/oidc/routes.ts`).
        {
          to: "/org-settings/cli-sessions",
          icon: Laptop,
          label: t("orgSettings.tabCliSessions"),
          show: isAdmin && oidcEnabled,
        },
        {
          to: "/org-settings/billing",
          icon: CreditCard,
          label: t("billing.tabTitle"),
          show: !!features.billing,
        },
      ],
    },
  ];

  return (
    <SettingsLayout
      title={t("orgSettings.pageTitle")}
      scope={{
        label: t("scope.organisation", { ns: "common" }),
        icon: Building,
        name: currentOrg?.name ?? "",
      }}
      sections={sections}
    />
  );
}
