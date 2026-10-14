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
import type { GateablePermission } from "../../hooks/use-permissions";
import { isUnder, type RoutePath } from "../../lib/route-access";

/** What a settings page configures, and the API scope its requests carry. */
export type SettingsScope = "organization" | "workspace" | "account";

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

function buildSettingsNavigation({
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

/** The entry a settings URL belongs to, nested URLs included; `undefined` when the rail lists none. */
export function activeSettingsItem(
  sections: UnifiedSettingsSection[],
  pathname: string,
): UnifiedSettingsNavItem | undefined {
  return sections.flatMap((section) => section.items).find((item) => isUnder(pathname, item.to));
}

const SETTINGS_INDEXES = ["/org-settings", "/workspace-settings", "/preferences"];

/** A scope's own index, which opens no page: on a phone it shows the rail. */
export function isSettingsIndex(pathname: string): boolean {
  return SETTINGS_INDEXES.includes(pathname.replace(/\/$/, ""));
}

export function settingsScopeFromPath(pathname: string): SettingsScope {
  if (isUnder(pathname, "/workspace-settings")) return "workspace";
  if (isUnder(pathname, "/preferences")) return "account";
  return "organization";
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
