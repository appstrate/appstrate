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
  ShieldCheck,
  Users,
} from "lucide-react";
import { SettingsLayout, type SettingsSection } from "../../components/settings-layout";
import { SpaceSettingsSwitcher } from "../../components/space-settings-switcher";
import type { BreadcrumbEntry } from "../../components/page-header";
import { usePermissions } from "../../hooks/use-permissions";
import { useAppConfig } from "../../hooks/use-app-config";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { useSpace } from "../../hooks/use-spaces";
import { useOrgSettings } from "../../hooks/use-org-settings";

export function OrgSettingsLayout() {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const { features } = useAppConfig();
  const spaceId = useCurrentSpaceId();
  const { data: space } = useSpace(spaceId ?? "");
  const location = useLocation();

  const oidcEnabled = !!features.oidc;
  const { data: orgSettings } = useOrgSettings();
  const dashboardSsoEnabled = !!orgSettings?.dashboard_sso_enabled;

  // Every tab is gated on the permission its own routes check, so a tab is
  // there exactly when the page behind it can load something.
  const spaceItems = [
    {
      to: "/org-settings/space/general",
      icon: Settings,
      label: t("spaceSettings.tabGeneral"),
      show: can("space-settings:write"),
    },
    {
      to: "/org-settings/space/members",
      icon: Users,
      label: t("spaceMembers.tabTitle"),
      show: can("space-members:read") || can("space-members:invite"),
    },
    {
      to: "/org-settings/space/api-keys",
      icon: KeyRound,
      label: t("orgSettings.tabApiKeys"),
      show: can("api-keys:read"),
    },
    {
      to: "/org-settings/space/auth",
      icon: Shield,
      label: t("spaceSettings.tabAuth"),
      show: oidcEnabled && can("spaces:write"),
    },
    {
      to: "/org-settings/space/oauth",
      icon: KeyRound,
      label: t("spaceSettings.tabOauth"),
      show: oidcEnabled && can("oauth-clients:read"),
    },
  ];

  const sections: SettingsSection[] = [
    {
      label: t("orgSettings.sectionOrganization"),
      items: [
        {
          to: "/org-settings/general",
          icon: Building,
          label: t("orgSettings.tabGeneral"),
          show: can("org:read"),
        },
        {
          to: "/org-settings/members",
          icon: Users,
          label: t("orgSettings.tabMembers", { count: 0 }),
          show: can("members:read"),
        },
        {
          to: "/org-settings/roles",
          icon: ShieldCheck,
          label: t("roles.tabTitle"),
          show: can("roles:read"),
        },
        {
          to: "/org-settings/spaces",
          icon: LayoutGrid,
          label: t("spaces.pageTitle"),
          show: can("spaces:read"),
        },
        {
          to: "/org-settings/models",
          icon: BrainCircuit,
          label: t("models.tabTitle"),
          show: can("models:read"),
        },
        {
          to: "/org-settings/proxies",
          icon: Globe,
          label: t("proxies.tabTitle"),
          show: can("proxies:read"),
        },
        {
          to: "/org-settings/oauth",
          icon: KeyRound,
          label: t("orgSettings.tabOauth"),
          show: can("oauth-clients:read") && oidcEnabled && dashboardSsoEnabled,
        },
        // CLI sessions oversight (issue #251 Phase 3) — gated on the OIDC
        // module being loaded (the backing endpoints live in
        // `apps/api/src/modules/oidc/routes.ts`).
        {
          to: "/org-settings/cli-sessions",
          icon: Laptop,
          label: t("orgSettings.tabCliSessions"),
          show: can("cli-sessions:read") && oidcEnabled,
        },
        {
          to: "/org-settings/billing",
          icon: CreditCard,
          label: t("billing.tabTitle"),
          show: !!features.billing && can("billing:read"),
        },
      ],
    },
    ...(space && spaceItems.some((i) => i.show)
      ? [{ label: t("orgSettings.sectionSpace"), items: spaceItems }]
      : []),
  ];

  const allItems = sections.flatMap((s) => s.items);
  const activeItem =
    allItems.find((i) => location.pathname === i.to) ??
    allItems.find((i) => location.pathname.startsWith(i.to + "/"));
  const isSpaceRoute = location.pathname.startsWith("/org-settings/space/");

  const breadcrumbs: BreadcrumbEntry[] = [
    { label: t("nav.orgSection", { ns: "common" }), href: "/" },
    { label: t("orgSettings.pageTitle"), href: "/org-settings" },
    ...(isSpaceRoute ? [{ label: space?.name ?? "", node: <SpaceSettingsSwitcher /> }] : []),
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
