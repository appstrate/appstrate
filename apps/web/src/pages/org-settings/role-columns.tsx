// SPDX-License-Identifier: Apache-2.0

/**
 * The roles column set.
 *
 * A role is a record — a name, what it is for, how much it grants — so the
 * roles page lists them in the settings table rather than as stacked cards
 * with an Edit and a Delete button on each. The row itself opens the role:
 * to read it when it is a preset or not yours to change, to edit it when it
 * is. Previewing it and deleting it live in the menu, the second being the
 * one destructive deed.
 *
 * Out of the page so `column-tiers.test.tsx` can measure it.
 */
import { useTranslation } from "react-i18next";
import { Eye, Trash2 } from "lucide-react";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import type { DataColumn } from "../../components/data-table";
import { TableRowActions } from "../../components/table-row-actions";
import { spaceRoleDescription, spaceRoleLabel, type RoleObject } from "../../hooks/use-roles";

export function useRoleColumns({
  canDelete,
  isDeleting,
  onDelete,
  onPreview,
}: {
  canDelete: (role: RoleObject) => boolean;
  isDeleting: boolean;
  onDelete: (role: RoleObject) => void;
  /** Absent when the caller may not preview a role. */
  onPreview?: (role: RoleObject) => void;
}): DataColumn<RoleObject>[] {
  const { t } = useTranslation(["settings", "common"]);

  return [
    {
      id: "role",
      header: t("roles.colRole"),
      width: "minmax(160px,2fr)",
      cell: (role) => (
        <span className="block min-w-0">
          <span className="block truncate text-sm font-medium">
            {spaceRoleLabel(role, t) ?? role.name}
          </span>
          <span className="text-muted-foreground block truncate text-xs">
            {spaceRoleDescription(role, t) ?? role.key}
          </span>
        </span>
      ),
    },
    {
      id: "permissions",
      header: t("roles.permissionsLabel"),
      width: "120px",
      align: "end",
      tier: 2,
      cell: (role) => (
        <span className="text-muted-foreground text-xs">
          {t("roles.permissionCount", { count: role.permissions.length })}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      width: "48px",
      align: "end",
      cell: (role) =>
        onPreview || canDelete(role) ? (
          <TableRowActions
            menuLabel={t("roles.moreActions", { name: spaceRoleLabel(role, t) ?? role.name })}
            isPending={isDeleting}
            pendingLabel={t("common:loading")}
          >
            {onPreview && (
              <DropdownMenuItem onSelect={() => onPreview(role)}>
                <Eye />
                {t("viewAs.rowAction")}
              </DropdownMenuItem>
            )}
            {canDelete(role) && (
              <DropdownMenuItem
                onSelect={() => onDelete(role)}
                disabled={isDeleting}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 />
                {t("common:btn.delete")}
              </DropdownMenuItem>
            )}
          </TableRowActions>
        ) : null,
    },
  ];
}
