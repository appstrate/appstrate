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
  Settings,
  Shield,
  ShieldCheck,
  Users,
  Webhook,
} from "lucide-react";
import type { GateablePermission } from "../../hooks/use-permissions";
import type { RoutePath } from "../../lib/route-access";
import type { SettingsScope } from "../../lib/settings-context";

export interface UnifiedSettingsNavItem {
  to: RoutePath;
  icon: LucideIcon;
  labelKey: string;
  show: boolean;
}

export interface UnifiedSettingsSection {
  scope: SettingsScope;
  labelKey: string;
  items: UnifiedSettingsNavItem[];
}

interface SettingsNavigationOptions {
  /** Whether `RouteGate` opens the route (`lib/route-access.ts`): feature, team space, permission. */
  canReach: (path: RoutePath) => boolean;
  can: (permission: GateablePermission) => boolean;
}

export function buildSettingsNavigation({
  canReach,
  can,
}: SettingsNavigationOptions): UnifiedSettingsSection[] {
  const entry = (
    to: RoutePath,
    icon: LucideIcon,
    labelKey: string,
    extra = true,
  ): UnifiedSettingsNavItem => ({ to, icon, labelKey, show: canReach(to) && extra });
  // The infrastructure screens are listed to whoever can change them: a guest
  // reads spaces, models and proxies so its runs resolve them, which is no
  // reason to open their administration. The routes stay on the read, so a
  // pasted URL still opens the read-only page.
  return [
    {
      scope: "organization",
      labelKey: "orgSettings.sectionOrganization",
      items: [
        entry("/org-settings/general", Building, "orgSettings.tabGeneral"),
        entry("/org-settings/members", Users, "orgSettings.tabMembers"),
        entry("/org-settings/roles", ShieldCheck, "roles.tabTitle"),
        entry("/org-settings/spaces", LayoutGrid, "applications.pageTitle", can("spaces:write")),
        entry("/org-settings/models", BrainCircuit, "models.tabTitle", can("models:write")),
        entry("/org-settings/proxies", Globe, "proxies.tabTitle", can("proxies:write")),
        entry("/org-settings/oauth", KeyRound, "orgSettings.tabOauth"),
        entry("/org-settings/cli-sessions", Laptop, "orgSettings.tabCliSessions"),
        entry("/org-settings/billing", CreditCard, "billing.tabTitle"),
      ],
    },
    {
      scope: "workspace",
      labelKey: "workspaceSettings.sectionGeneral",
      items: [
        entry("/workspace-settings/general", Settings, "appSettings.tabGeneral"),
        entry("/workspace-settings/members", Users, "spaceMembers.tabTitle"),
        entry("/workspace-settings/auth", Shield, "appSettings.tabAuth"),
        entry("/workspace-settings/api-keys", KeyRound, "orgSettings.tabApiKeys"),
        entry("/workspace-settings/oauth", KeyRound, "appSettings.tabOauth"),
        entry("/workspace-settings/end-users", Users, "endUsers.pageTitle"),
        entry("/workspace-settings/webhooks", Webhook, "webhooks.pageTitle"),
      ],
    },
  ];
}

/** The rail as drawn: entries the caller cannot use are gone, empty sections too. */
export function visibleSettingsSections(
  options: SettingsNavigationOptions,
): UnifiedSettingsSection[] {
  return buildSettingsNavigation(options)
    .map((section) => ({ ...section, items: section.items.filter((item) => item.show) }))
    .filter((section) => section.items.length > 0);
}

/**
 * Where a settings index opens: the first entry the rail lists in that scope,
 * else the rail's first entry; `undefined` when the rail is empty.
 */
export function firstSettingsPath(
  sections: UnifiedSettingsSection[],
  scope: SettingsScope,
): RoutePath | undefined {
  return (sections.find((section) => section.scope === scope) ?? sections[0])?.items[0]?.to;
}
