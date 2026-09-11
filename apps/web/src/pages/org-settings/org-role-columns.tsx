// SPDX-License-Identifier: Apache-2.0

/**
 * The organisation roles as data: the four roles, what each can do, how far
 * each reaches into spaces, and the list's column set.
 *
 * MIRRORS `ORG_ROLE_PERMISSIONS` in `apps/api/src/lib/permissions.ts`, which
 * the browser bundle cannot import: a change to a role's set there has to be
 * written here too. Out of the component file so `column-tiers.test.tsx` can
 * measure the columns.
 */
import { useTranslation } from "react-i18next";
import type { OrgRole } from "@appstrate/shared-types";
import type { DataColumn } from "../../components/data-table";
import { roleI18nKey } from "../../hooks/use-permissions";

export const ORG_ROLES_ORDER: readonly OrgRole[] = ["owner", "admin", "member", "guest"];

/** Capability → the org roles holding it, with the permissions it stands for. */
export const ORG_ROLE_CAPABILITIES: readonly { key: string; roles: readonly OrgRole[] }[] = [
  // org:read, spaces:read, models:read, proxies:read
  { key: "view", roles: ["owner", "admin", "member", "guest"] },
  // members:read — a guest does not enumerate the directory
  { key: "directory", roles: ["owner", "admin", "member"] },
  // members:invite, members:remove, members:change-role (on members and guests)
  { key: "manageMembers", roles: ["owner", "admin"] },
  // roles:write, roles:delete
  { key: "customRoles", roles: ["owner", "admin"] },
  // spaces:write, spaces:delete
  { key: "spaces", roles: ["owner", "admin"] },
  // models:*, model-provider-credentials:*, proxies:*
  { key: "infrastructure", roles: ["owner", "admin"] },
  // org:settings
  { key: "settings", roles: ["owner", "admin"] },
  // org:update, org:delete — the org's identity is owner-only
  { key: "identity", roles: ["owner"] },
];

/** How far each org role reaches into spaces (`resolveSpaceRole`). */
export const ORG_ROLE_SPACE_ACCESS: Record<OrgRole, "all" | "open" | "assigned"> = {
  owner: "all",
  admin: "all",
  member: "open",
  guest: "assigned",
};

export function useOrgRoleColumns(): DataColumn<OrgRole>[] {
  const { t } = useTranslation(["settings", "common"]);
  return [
    {
      id: "role",
      header: t("roles.colRole"),
      width: "minmax(200px,2fr)",
      cell: (role) => (
        <span className="block min-w-0 py-1">
          <span className="block text-sm font-medium">{t(roleI18nKey(role))}</span>
          <span className="text-muted-foreground block text-xs leading-relaxed whitespace-normal">
            {t(`orgSettings.roleHint.${role}`)}
          </span>
        </span>
      ),
    },
    {
      id: "access",
      header: t("orgRolesGuide.spaceAccess"),
      width: "minmax(140px,1fr)",
      tier: 2,
      cell: (role) => (
        <span className="text-muted-foreground block text-xs whitespace-normal">
          {t(`orgRolesGuide.access.${ORG_ROLE_SPACE_ACCESS[role]}`)}
        </span>
      ),
    },
  ];
}
