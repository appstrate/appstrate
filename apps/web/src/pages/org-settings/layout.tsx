// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import {
  BrainCircuit,
  Building,
  CreditCard,
  Globe,
  KeyRound,
  Laptop,
  LayoutGrid,
  Settings,
  Shield,
  UserCircle,
  Users,
} from "lucide-react";
import { SettingsLayout, type SettingsSection } from "../../components/settings-layout";
import { AppSettingsSwitcher } from "../../components/app-settings-switcher";
import type { BreadcrumbEntry } from "../../components/page-header";
import { usePermissions } from "../../hooks/use-permissions";
import { useAppConfig } from "../../hooks/use-app-config";
import { useCurrentApplicationId } from "../../hooks/use-current-application";
import { useApplication } from "../../hooks/use-applications";
import { useOrgSettings } from "../../hooks/use-org-settings";

export function OrgSettingsLayout() {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();
  const { features } = useAppConfig();
  const applicationId = useCurrentApplicationId();
  const { data: application } = useApplication(applicationId ?? "");
  const location = useLocation();

  const oidcEnabled = !!features.oidc;
  const { data: orgSettings } = useOrgSettings();
  const dashboardSsoEnabled = !!orgSettings?.dashboardSsoEnabled;

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
    ...(isAdmin && application
      ? [
          {
            label: t("orgSettings.sectionApplication"),
            items: [
              {
                to: "/org-settings/app/general",
                icon: Settings,
                label: t("appSettings.tabGeneral"),
              },
              {
                to: "/org-settings/app/profiles",
                icon: UserCircle,
                label: t("appSettings.tabProfiles"),
              },
              {
                to: "/org-settings/app/api-keys",
                icon: KeyRound,
                label: t("orgSettings.tabApiKeys"),
              },
              {
                to: "/org-settings/app/auth",
                icon: Shield,
                label: t("appSettings.tabAuth"),
                show: oidcEnabled,
              },
              {
                to: "/org-settings/app/oauth",
                icon: KeyRound,
                label: t("appSettings.tabOauth"),
                show: oidcEnabled,
              },
            ],
          },
        ]
      : []),
  ];

  const allItems = sections.flatMap((s) => s.items);
  const activeItem =
    allItems.find((i) => location.pathname === i.to) ??
    allItems.find((i) => location.pathname.startsWith(i.to + "/"));
  const isAppRoute = location.pathname.startsWith("/org-settings/app/");

  const breadcrumbs: BreadcrumbEntry[] = [
    { label: t("nav.orgSection", { ns: "common" }), href: "/" },
    { label: t("orgSettings.pageTitle"), href: "/org-settings" },
    ...(isAppRoute ? [{ label: application?.name ?? "", node: <AppSettingsSwitcher /> }] : []),
    ...(activeItem ? [{ label: activeItem.label }] : []),
  ];

  return (
    <SettingsLayout
      title={t("orgSettings.pageTitle")}
      emoji="⚙️"
      breadcrumbs={breadcrumbs}
      sections={sections}
    />
  );
}
