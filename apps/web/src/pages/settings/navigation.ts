// SPDX-License-Identifier: Apache-2.0

import type { LucideIcon } from "lucide-react";
import {
  BrainCircuit,
  Building,
  CreditCard,
  Globe,
  KeyRound,
  Laptop,
  Library,
  LayoutGrid,
  Plug,
  Settings,
  Shield,
  ShieldCheck,
  Users,
  Webhook,
} from "lucide-react";
import type { GateablePermission } from "../../hooks/use-permissions";
import { WEBHOOK_READ_PERMISSIONS } from "../../lib/webhook-permissions";
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
  items: UnifiedSettingsNavItem[];
}

interface SettingsNavigationOptions {
  /**
   * Every entry is gated on the permission its own route checks, so an entry
   * is there exactly when the page behind it can load something.
   */
  can: (permission: GateablePermission) => boolean;
  features: {
    oidc: boolean;
    billing: boolean;
    webhooks: boolean;
  };
}

export function buildSettingsNavigation({
  can,
  features,
}: SettingsNavigationOptions): UnifiedSettingsSection[] {
  return [
    {
      scope: "organization",
      labelKey: "orgSettings.sectionOrganization",
      items: [
        {
          to: "/org-settings/general",
          icon: Building,
          labelKey: "orgSettings.tabGeneral",
          show: can("org:read"),
        },
        {
          to: "/org-settings/members",
          icon: Users,
          labelKey: "orgSettings.tabMembers",
          show: can("members:read"),
        },
        {
          to: "/org-settings/roles",
          icon: ShieldCheck,
          labelKey: "roles.tabTitle",
          show: can("roles:read"),
        },
        {
          to: "/org-settings/spaces",
          icon: LayoutGrid,
          labelKey: "applications.pageTitle",
          show: can("spaces:read"),
        },
        {
          to: "/org-settings/library",
          icon: Library,
          labelKey: "orgSettings.tabLibrary",
          show: can("spaces:read"),
        },
        {
          to: "/org-settings/models",
          icon: BrainCircuit,
          labelKey: "models.tabTitle",
          show: can("models:read"),
        },
        {
          to: "/org-settings/proxies",
          icon: Globe,
          labelKey: "proxies.tabTitle",
          show: can("proxies:read"),
        },
        {
          // Shown before collaborator SSO is switched on: this is where it is.
          to: "/org-settings/oauth",
          icon: KeyRound,
          labelKey: "orgSettings.tabOauth",
          show: features.oidc && can("oauth-clients:read"),
        },
        {
          to: "/org-settings/cli-sessions",
          icon: Laptop,
          labelKey: "orgSettings.tabCliSessions",
          show: features.oidc && can("cli-sessions:read"),
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
          show: features.billing && can("billing:read"),
        },
      ],
    },
    {
      scope: "workspace",
      labelKey: "workspaceSettings.sectionGeneral",
      items: [
        {
          to: "/workspace-settings/general",
          icon: Settings,
          labelKey: "appSettings.tabGeneral",
          show: can("space-settings:write"),
        },
        {
          to: "/workspace-settings/members",
          icon: Users,
          labelKey: "spaceMembers.tabTitle",
          show: can("space-members:read") || can("space-members:invite"),
        },
        {
          to: "/workspace-settings/auth",
          icon: Shield,
          labelKey: "appSettings.tabAuth",
          show: features.oidc && can("spaces:write"),
        },
        {
          to: "/workspace-settings/api-keys",
          icon: KeyRound,
          labelKey: "orgSettings.tabApiKeys",
          show: can("api-keys:read"),
        },
        {
          to: "/workspace-settings/oauth",
          icon: KeyRound,
          labelKey: "appSettings.tabOauth",
          show: features.oidc && can("oauth-clients:read"),
        },
        {
          to: "/workspace-settings/end-users",
          icon: Users,
          labelKey: "endUsers.pageTitle",
          show: can("end-users:read"),
        },
        {
          to: "/workspace-settings/webhooks",
          icon: Webhook,
          labelKey: "webhooks.pageTitle",
          show: features.webhooks && WEBHOOK_READ_PERMISSIONS.some(can),
        },
      ],
    },
  ];
}
