// SPDX-License-Identifier: Apache-2.0

/**
 * The organization roles as data: the four roles, how far each reaches into
 * spaces, and the list's column set (what each can do is
 * `lib/org-role-capabilities.ts`). Out of the component file so
 * `column-tiers.test.tsx` can measure the columns.
 */
import { useTranslation } from "react-i18next";
import { Eye } from "lucide-react";
import { VIEW_AS_ORG_ROLES, type ViewAsOrgRole } from "@appstrate/core/permissions";
import type { OrgRole } from "@appstrate/shared-types";
import type { DataColumn } from "../../components/data-table";
import { TableRowActions } from "../../components/table-row-actions";
import { rowActionsColumn } from "../../components/row-actions-column";
import { roleI18nKey } from "../../hooks/use-permissions";

export const ORG_ROLES_ORDER: readonly OrgRole[] = ["owner", "admin", "member", "guest"];

/** How far each org role reaches into spaces (`resolveSpaceRole`). */
export const ORG_ROLE_SPACE_ACCESS: Record<OrgRole, "all" | "open" | "assigned"> = {
  owner: "all",
  admin: "all",
  member: "open",
  guest: "assigned",
};

function isPreviewable(role: OrgRole): role is ViewAsOrgRole {
  return (VIEW_AS_ORG_ROLES as readonly OrgRole[]).includes(role);
}

/** `onPreview` is absent when the caller may not preview a role; owner and admin never are (a preview only removes). */
export function useOrgRoleColumns({
  onPreview,
}: {
  onPreview?: (role: ViewAsOrgRole) => void;
} = {}): DataColumn<OrgRole>[] {
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
    rowActionsColumn((role: OrgRole) =>
      onPreview && isPreviewable(role) ? (
        <TableRowActions
          menuLabel={t("roles.moreActions", { name: t(roleI18nKey(role)) })}
          actions={[
            {
              id: "preview",
              label: t("viewAs.rowAction"),
              icon: Eye,
              onSelect: () => onPreview(role),
            },
          ]}
        />
      ) : null,
    ),
  ];
}
