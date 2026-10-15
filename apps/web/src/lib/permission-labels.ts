// SPDX-License-Identifier: Apache-2.0

/**
 * Readable names for permission strings.
 *
 * A permission reads `agents:run` on the wire and "Lancer les agents" on
 * screen. A string with no translation — a module's, say — shows as itself
 * rather than as a blank, so a new permission is never invisible.
 *
 * Keys use a dot where the wire uses a colon: `:` is i18next's namespace
 * separator, so `permissions.label.agents:run` would look up a namespace.
 */
type Translate = (key: string) => string;

function translated(t: Translate, key: string, fallback: string): string {
  const value = t(key);
  return value === key ? fallback : value;
}

export function permissionResourceLabel(resource: string, t: Translate): string {
  return translated(t, `permissions.resource.${resource}`, resource);
}

export function permissionLabel(permission: string, t: Translate): string {
  const colon = permission.indexOf(":");
  if (colon < 0) return permission;
  const resource = permission.slice(0, colon);
  const action = permission.slice(colon + 1);
  return translated(t, `permissions.label.${resource}.${action}`, permission);
}

/** Permissions under their resource, in the order given (the catalog's, sorted). */
export function groupPermissionsByResource(permissions: readonly string[]): [string, string[]][] {
  const groups = new Map<string, string[]>();
  for (const permission of permissions) {
    const resource = permission.slice(0, Math.max(permission.indexOf(":"), 0)) || permission;
    const list = groups.get(resource) ?? [];
    list.push(permission);
    groups.set(resource, list);
  }
  return [...groups.entries()];
}
