// SPDX-License-Identifier: Apache-2.0

import type { LucideIcon } from "lucide-react";
import {
  BrainCircuit,
  Building,
  CreditCard,
  Globe,
  KeyRound,
  Laptop,
  LayoutGrid,
  Plug,
  Settings,
  Shield,
  Users,
  Webhook,
} from "lucide-react";
import type { SettingsScope } from "../../lib/settings-context";

export interface UnifiedSettingsNavItem {
  to: string;
  icon: LucideIcon;
  labelKey: string;
  show?: boolean;
}

export interface UnifiedSettingsSection {
  scope: SettingsScope;
  labelKey: string;
  icon: LucideIcon;
  items: UnifiedSettingsNavItem[];
}

interface SettingsNavigationOptions {
  isAdmin: boolean;
  features: {
    oidc: boolean;
    billing: boolean;
    webhooks: boolean;
  };
}

export function buildSettingsNavigation({
  isAdmin,
  features,
}: SettingsNavigationOptions): UnifiedSettingsSection[] {
  return [
    {
      scope: "organization",
      labelKey: "orgSettings.sectionOrganization",
      icon: Building,
      items: [
        { to: "/org-settings/general", icon: Building, labelKey: "orgSettings.tabGeneral" },
        { to: "/org-settings/members", icon: Users, labelKey: "orgSettings.tabMembers" },
        {
          to: "/org-settings/applications",
          icon: LayoutGrid,
          labelKey: "applications.pageTitle",
        },
        {
          to: "/org-settings/models",
          icon: BrainCircuit,
          labelKey: "models.tabTitle",
          show: isAdmin,
        },
        {
          to: "/org-settings/proxies",
          icon: Globe,
          labelKey: "proxies.tabTitle",
          show: isAdmin,
        },
        {
          to: "/org-settings/oauth",
          icon: KeyRound,
          labelKey: "orgSettings.tabOauth",
          show: isAdmin && features.oidc,
        },
        {
          to: "/org-settings/cli-sessions",
          icon: Laptop,
          labelKey: "orgSettings.tabCliSessions",
          show: isAdmin && features.oidc,
        },
        {
          to: "/org-settings/mcp-access",
          icon: Plug,
          labelKey: "orgSettings.tabMcpAccess",
        },
        {
          to: "/org-settings/billing",
          icon: CreditCard,
          labelKey: "billing.tabTitle",
          show: features.billing,
        },
      ],
    },
    {
      scope: "workspace",
      labelKey: "workspaceSettings.sectionGeneral",
      icon: LayoutGrid,
      items: [
        {
          to: "/workspace-settings/general",
          icon: Settings,
          labelKey: "appSettings.tabGeneral",
          show: isAdmin,
        },
        {
          to: "/workspace-settings/auth",
          icon: Shield,
          labelKey: "appSettings.tabAuth",
          show: isAdmin && features.oidc,
        },
        {
          to: "/workspace-settings/api-keys",
          icon: KeyRound,
          labelKey: "orgSettings.tabApiKeys",
          show: isAdmin,
        },
        {
          to: "/workspace-settings/oauth",
          icon: KeyRound,
          labelKey: "appSettings.tabOauth",
          show: isAdmin && features.oidc,
        },
        {
          to: "/workspace-settings/end-users",
          icon: Users,
          labelKey: "endUsers.pageTitle",
          show: isAdmin,
        },
        {
          to: "/workspace-settings/webhooks",
          icon: Webhook,
          labelKey: "webhooks.pageTitle",
          show: isAdmin && features.webhooks,
        },
      ],
    },
  ];
}
