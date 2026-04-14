// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { BrainCircuit, Building, CreditCard, Globe, KeyRound, Users } from "lucide-react";
import { SettingsLayout } from "../../components/settings-layout";
import { usePermissions } from "../../hooks/use-permissions";
import { useAppConfig } from "../../hooks/use-app-config";

export function OrgSettingsLayout() {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();
  const { features } = useAppConfig();

  const oidcEnabled = !!features.oidc;

  return (
    <SettingsLayout
      title={t("orgSettings.pageTitle")}
      emoji="⚙️"
      breadcrumbs={[
        { label: t("nav.orgSection", { ns: "common" }), href: "/" },
        { label: t("orgSettings.pageTitle") },
      ]}
      legacyHashRedirects={{
        general: "/org-settings/general",
        members: "/org-settings/members",
        models: "/org-settings/models",
        proxies: "/org-settings/proxies",
        oauth: "/org-settings/oauth",
        billing: "/org-settings/billing",
      }}
      sections={[
        {
          items: [
            { to: "/org-settings/general", icon: Building, label: t("orgSettings.tabGeneral") },
            {
              to: "/org-settings/members",
              icon: Users,
              label: t("orgSettings.tabMembers", { count: 0 }),
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
              label: "OAuth",
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
      ]}
    />
  );
}
