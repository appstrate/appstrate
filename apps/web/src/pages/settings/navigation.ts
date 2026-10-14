// SPDX-License-Identifier: Apache-2.0

import type { LucideIcon } from "lucide-react";
import {
  Blocks,
  BrainCircuit,
  Building,
  CreditCard,
  Globe,
  KeyRound,
  Laptop,
  LayoutGrid,
  Palette,
  Plug,
  Settings,
  Shield,
  ShieldCheck,
  User,
  Users,
  Webhook,
} from "lucide-react";
import {
  isUnder,
  SETTINGS_INDEX,
  type RoutePath,
  type SettingsScope,
} from "../../lib/route-access";

export interface UnifiedSettingsNavItem {
  to: RoutePath;
  icon: LucideIcon;
  labelKey: string;
}

export interface UnifiedSettingsSection {
  scope: SettingsScope;
  labelKey: string;
  items: UnifiedSettingsNavItem[];
}

/**
 * The rail as drawn: entries whose route `RouteGate` refuses (feature, team
 * space, permission) are gone, empty sections too.
 */
export function visibleSettingsSections(
  canReach: (path: RoutePath) => boolean,
): UnifiedSettingsSection[] {
  const entry = (
    to: RoutePath,
    icon: LucideIcon,
    labelKey: string,
  ): UnifiedSettingsNavItem | null => (canReach(to) ? { to, icon, labelKey } : null);
  const sections: {
    scope: SettingsScope;
    labelKey: string;
    items: (UnifiedSettingsNavItem | null)[];
  }[] = [
    {
      scope: "organization",
      labelKey: "orgSettings.sectionOrganization",
      items: [
        entry("/org-settings/general", Building, "orgSettings.tabGeneral"),
        entry("/org-settings/members", Users, "orgSettings.tabMembers"),
        entry("/org-settings/roles", ShieldCheck, "roles.tabTitle"),
        entry("/org-settings/spaces", LayoutGrid, "spaces.pageTitle"),
        entry("/org-settings/models", BrainCircuit, "models.tabTitle"),
        entry("/org-settings/proxies", Globe, "proxies.tabTitle"),
        entry("/org-settings/oauth", KeyRound, "orgSettings.tabOauth"),
        entry("/org-settings/cli-sessions", Laptop, "orgSettings.tabCliSessions"),
        entry("/org-settings/billing", CreditCard, "billing.tabTitle"),
      ],
    },
    {
      scope: "workspace",
      labelKey: "workspaceSettings.sectionGeneral",
      items: [
        entry("/workspace-settings/general", Settings, "spaceSettings.tabGeneral"),
        entry("/workspace-settings/members", Users, "spaceMembers.tabTitle"),
        entry("/workspace-settings/auth", Shield, "spaceSettings.tabAuth"),
        entry("/workspace-settings/api-keys", KeyRound, "orgSettings.tabApiKeys"),
        entry("/workspace-settings/oauth", KeyRound, "spaceSettings.tabOauth"),
        entry("/workspace-settings/end-users", Users, "endUsers.pageTitle"),
        entry("/workspace-settings/webhooks", Webhook, "webhooks.pageTitle"),
      ],
    },
    {
      scope: "account",
      labelKey: "preferences.sectionAccount",
      items: [
        entry("/preferences/general", User, "preferences.tabGeneral"),
        entry("/preferences/appearance", Palette, "preferences.tabAppearance"),
        entry("/preferences/security", Shield, "preferences.tabSecurity"),
        entry("/preferences/devices", Laptop, "preferences.tabDevices"),
        entry("/preferences/connections", Plug, "preferences.tabConnections"),
        entry("/preferences/mcp-access", Blocks, "orgSettings.tabMcpAccess"),
        entry("/preferences/models", KeyRound, "preferences.tabModels"),
      ],
    },
  ];
  return sections
    .map((section) => ({ ...section, items: section.items.filter((item) => item !== null) }))
    .filter((section) => section.items.length > 0);
}

/**
 * Where a scope's index opens: the first entry the rail lists in that scope,
 * else the scope's General page, whose gate says why it is refused.
 */
export function firstSettingsPath(
  sections: UnifiedSettingsSection[],
  scope: SettingsScope,
): RoutePath {
  return (
    sections.find((section) => section.scope === scope)?.items[0]?.to ??
    (`${SETTINGS_INDEX[scope]}/general` as const)
  );
}

/** The entry a settings URL belongs to, nested URLs included; `undefined` when the rail lists none. */
export function activeSettingsItem(
  sections: UnifiedSettingsSection[],
  pathname: string,
): UnifiedSettingsNavItem | undefined {
  return sections.flatMap((section) => section.items).find((item) => isUnder(pathname, item.to));
}

export function settingsScopeFromPath(pathname: string): SettingsScope {
  const scopes = Object.keys(SETTINGS_INDEX) as SettingsScope[];
  return scopes.find((scope) => isUnder(pathname, SETTINGS_INDEX[scope])) ?? "organization";
}

/** Keys the content outlet: a context switch remounts the page instead of flashing the previous scope's data. */
export function settingsContentKey(
  pathname: string,
  organizationId: string | null,
  workspaceId: string | null,
): string {
  const scope = settingsScopeFromPath(pathname);
  const organization = organizationId ?? "none";
  return scope === "workspace"
    ? `workspace:${organization}:${workspaceId ?? "none"}`
    : `${scope}:${organization}`;
}
