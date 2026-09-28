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
import { useCanReach } from "../../hooks/use-can-reach";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { useSpace } from "../../hooks/use-spaces";
import { useOrgSettings } from "../../hooks/use-org-settings";

export function OrgSettingsLayout() {
  const { t } = useTranslation(["settings", "common"]);
  const canReach = useCanReach();
  const spaceId = useCurrentSpaceId();
  const { data: space } = useSpace(spaceId ?? "");
  const location = useLocation();

  const { data: orgSettings } = useOrgSettings();
  const dashboardSsoEnabled = !!orgSettings?.dashboard_sso_enabled;

  // Every tab is there exactly when its route's declaration (`lib/route-access.ts`,
  // also the route gate) opens the page behind it; `show` adds only what is not
  // a permission or a module — the state of this space or this org.
  const spaceItems = [
    {
      to: "/org-settings/space/general",
      icon: Settings,
      label: t("spaceSettings.tabGeneral"),
      show: canReach("/org-settings/space/general"),
    },
    {
      to: "/org-settings/space/members",
      icon: Users,
      label: t("spaceMembers.tabTitle"),
      // A personal space takes no members at all (RBAC spec §3.6): the write
      // routes answer 409 and the list would only ever hold its owner, so the
      // tab is not there rather than there and empty.
      show: !space?.personal && canReach("/org-settings/space/members"),
    },
    {
      to: "/org-settings/space/api-keys",
      icon: KeyRound,
      label: t("orgSettings.tabApiKeys"),
      show: canReach("/org-settings/space/api-keys"),
    },
    {
      to: "/org-settings/space/auth",
      icon: Shield,
      label: t("spaceSettings.tabAuth"),
      show: canReach("/org-settings/space/auth"),
    },
    {
      to: "/org-settings/space/oauth",
      icon: KeyRound,
      label: t("spaceSettings.tabOauth"),
      show: canReach("/org-settings/space/oauth"),
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
          show: canReach("/org-settings/general"),
        },
        {
          to: "/org-settings/members",
          icon: Users,
          label: t("orgSettings.tabMembers", { count: 0 }),
          show: canReach("/org-settings/members"),
        },
        {
          to: "/org-settings/roles",
          icon: ShieldCheck,
          label: t("roles.tabTitle"),
          show: canReach("/org-settings/roles"),
        },
        {
          to: "/org-settings/spaces",
          icon: LayoutGrid,
          label: t("spaces.pageTitle"),
          show: canReach("/org-settings/spaces"),
        },
        {
          to: "/org-settings/models",
          icon: BrainCircuit,
          label: t("models.tabTitle"),
          show: canReach("/org-settings/models"),
        },
        {
          to: "/org-settings/proxies",
          icon: Globe,
          label: t("proxies.tabTitle"),
          show: canReach("/org-settings/proxies"),
        },
        {
          to: "/org-settings/oauth",
          icon: KeyRound,
          label: t("orgSettings.tabOauth"),
          show: canReach("/org-settings/oauth") && dashboardSsoEnabled,
        },
        // CLI sessions oversight (issue #251 Phase 3).
        {
          to: "/org-settings/cli-sessions",
          icon: Laptop,
          label: t("orgSettings.tabCliSessions"),
          show: canReach("/org-settings/cli-sessions"),
        },
        {
          to: "/org-settings/billing",
          icon: CreditCard,
          label: t("billing.tabTitle"),
          show: canReach("/org-settings/billing"),
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

  // A space page is reached through the org's Spaces list, not through the
  // organization settings root: the trail names where the page lives.
  const breadcrumbs: BreadcrumbEntry[] = [
    { label: t("nav.orgSection", { ns: "common" }), href: "/" },
    isSpaceRoute
      ? { label: t("spaces.pageTitle"), href: "/org-settings/spaces" }
      : { label: t("orgSettings.pageTitle"), href: "/org-settings" },
    ...(isSpaceRoute ? [{ label: space?.name ?? "", node: <SpaceSettingsSwitcher /> }] : []),
    ...(activeItem ? [{ label: activeItem.label }] : []),
  ];

  return (
    <SettingsLayout
      title={t(isSpaceRoute ? "orgSettings.spaceTitle" : "orgSettings.pageTitle")}
      emoji="⚙️"
      breadcrumbs={breadcrumbs}
      sections={sections}
    />
  );
}
