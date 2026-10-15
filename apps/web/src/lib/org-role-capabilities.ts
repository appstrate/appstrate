// SPDX-License-Identifier: Apache-2.0

import type { OrgLevelPermission } from "@appstrate/core/permissions";

interface OrgRoleCapability {
  /** `orgRolesGuide.can.<key>` names the row. */
  key: string;
  /** The org-level permissions the capability stands for. */
  permissions: readonly OrgLevelPermission[];
}

/**
 * The rows of the roles page: each a capability, the org-level permissions it stands for. Which
 * role holds it is the server's answer (`GET /api/org-roles`, {@link holdsCapability}), never a
 * copy of its matrix: a role holds a row when it is granted every permission of it.
 */
export const ORG_ROLE_CAPABILITIES: readonly OrgRoleCapability[] = [
  {
    key: "view",
    permissions: ["org:read", "spaces:read", "models:read", "proxies:read"],
  },
  // A guest does not enumerate the directory.
  { key: "directory", permissions: ["members:read"] },
  {
    key: "manageMembers",
    permissions: ["members:invite", "members:remove", "members:change-role"],
  },
  { key: "customRoles", permissions: ["roles:write", "roles:delete"] },
  { key: "spaces", permissions: ["spaces:write", "spaces:delete"] },
  {
    key: "infrastructure",
    permissions: [
      "models:read",
      "models:write",
      "models:delete",
      "model-provider-credentials:read",
      "model-provider-credentials:write",
      "model-provider-credentials:delete",
      "model-provider-credentials:connect",
      "proxies:read",
      "proxies:write",
      "proxies:delete",
    ],
  },
  { key: "settings", permissions: ["org:settings"] },
  // The org's identity is owner-only.
  { key: "identity", permissions: ["org:update", "org:delete"] },
];

/** Whether a role granted `granted` holds `capability`: every permission it stands for. */
export function holdsCapability(
  capability: OrgRoleCapability,
  granted: ReadonlySet<string>,
): boolean {
  return capability.permissions.every((permission) => granted.has(permission));
}
