// SPDX-License-Identifier: Apache-2.0

import type { OrgLevelPermission } from "@appstrate/core/permissions";
import type { OrgRole } from "@appstrate/shared-types";

interface OrgRoleCapability {
  /** `orgRolesGuide.can.<key>` names the row. */
  key: string;
  /** The org-level permissions the capability stands for. */
  permissions: readonly OrgLevelPermission[];
  /** The roles holding every one of them. */
  roles: readonly OrgRole[];
}

/**
 * What each org role can do, as the roles page draws it. The roles are those
 * of `ORG_ROLE_PERMISSIONS` (`apps/api/src/lib/permissions.ts`), which the
 * browser bundle cannot import; `apps/api/test/unit/org-role-capabilities.test.ts`
 * holds the two in parity.
 */
export const ORG_ROLE_CAPABILITIES: readonly OrgRoleCapability[] = [
  {
    key: "view",
    permissions: ["org:read", "spaces:read", "models:read", "proxies:read"],
    roles: ["owner", "admin", "member", "guest"],
  },
  // A guest does not enumerate the directory.
  { key: "directory", permissions: ["members:read"], roles: ["owner", "admin", "member"] },
  {
    key: "manageMembers",
    permissions: ["members:invite", "members:remove", "members:change-role"],
    roles: ["owner", "admin"],
  },
  { key: "customRoles", permissions: ["roles:write", "roles:delete"], roles: ["owner", "admin"] },
  { key: "spaces", permissions: ["spaces:write", "spaces:delete"], roles: ["owner", "admin"] },
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
    roles: ["owner", "admin"],
  },
  { key: "settings", permissions: ["org:settings"], roles: ["owner", "admin"] },
  // The org's identity is owner-only.
  { key: "identity", permissions: ["org:update", "org:delete"], roles: ["owner"] },
];
