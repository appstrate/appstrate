// SPDX-License-Identifier: Apache-2.0

/**
 * The two dialogs the settings scopes open in: Settings holds what the caller
 * administers (organization, workspace), Preferences what is their own
 * (account). One shell draws both; each lists only its own scopes.
 */
import { Settings, UserCog, type LucideIcon } from "lucide-react";
import { isSettingsPath, settingsScopeFromPath, type SettingsScope } from "./route-access";

export type SettingsSurface = "settings" | "preferences";

const SURFACE_OF_SCOPE: Record<SettingsScope, SettingsSurface> = {
  organization: "settings",
  workspace: "settings",
  account: "preferences",
};

/** Each dialog's name (its title, its rail's header, its breadcrumb's root) and icon. */
export const SETTINGS_SURFACES: Record<SettingsSurface, { titleKey: string; icon: LucideIcon }> = {
  settings: { titleKey: "common:nav.settings", icon: Settings },
  preferences: { titleKey: "common:userMenu.preferences", icon: UserCog },
};

export const surfaceOfScope = (scope: SettingsScope): SettingsSurface => SURFACE_OF_SCOPE[scope];

/** The dialog a URL opens; `undefined` outside the settings scopes. */
export function settingsSurfaceFromPath(pathname: string): SettingsSurface | undefined {
  return isSettingsPath(pathname) ? surfaceOfScope(settingsScopeFromPath(pathname)) : undefined;
}

/** What a dialog lists, out of anything grouped by scope (its rail's sections, their placeholders). */
export function inSurface<T extends { scope: SettingsScope }>(
  groups: readonly T[],
  surface: SettingsSurface,
): T[] {
  return groups.filter((group) => surfaceOfScope(group.scope) === surface);
}
