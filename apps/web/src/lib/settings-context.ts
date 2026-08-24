// SPDX-License-Identifier: Apache-2.0

export type SettingsScope = "organization" | "workspace";

interface WorkspaceChoice {
  id: string;
  isDefault: boolean;
}

const LAST_WORKSPACE_STORAGE_KEY = "appstrate_settings_last_workspace_by_org";

export function pickWorkspaceForOrganization<T extends WorkspaceChoice>(
  workspaces: T[],
  lastWorkspaceId: string | null,
): T | null {
  return (
    workspaces.find((workspace) => workspace.id === lastWorkspaceId) ??
    workspaces.find((workspace) => workspace.isDefault) ??
    workspaces[0] ??
    null
  );
}

export function settingsScopeFromPath(pathname: string): SettingsScope {
  return pathname.startsWith("/workspace-settings") ? "workspace" : "organization";
}

export function settingsContentKey(
  pathname: string,
  organizationId: string | null,
  workspaceId: string | null,
): string {
  const scope = settingsScopeFromPath(pathname);
  return scope === "workspace"
    ? `workspace:${organizationId ?? "none"}:${workspaceId ?? "none"}`
    : `organization:${organizationId ?? "none"}`;
}

function readLastWorkspaces(): Record<string, string> {
  try {
    const stored = window.localStorage.getItem(LAST_WORKSPACE_STORAGE_KEY);
    return stored ? (JSON.parse(stored) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function getLastWorkspaceId(organizationId: string): string | null {
  return readLastWorkspaces()[organizationId] ?? null;
}

export function rememberWorkspace(organizationId: string, workspaceId: string): void {
  try {
    window.localStorage.setItem(
      LAST_WORKSPACE_STORAGE_KEY,
      JSON.stringify({ ...readLastWorkspaces(), [organizationId]: workspaceId }),
    );
  } catch {
    // Storage can be unavailable in hardened browsers. The default workspace
    // remains a deterministic fallback, so context switching still works.
  }
}
