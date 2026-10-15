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
import type { DataColumn } from "../../components/data-table";
import { TableRowActions } from "../../components/table-row-actions";
import { rowActionsColumn } from "../../components/row-actions-column";
import { CellText } from "../../components/table-cells";
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
      width: 160,
      elastic: true,
      cell: (role) => (
        <span className="block min-w-0">
          <CellText strong title={spaceRoleLabel(role, t) ?? role.name}>
            {spaceRoleLabel(role, t) ?? role.name}
          </CellText>
          <CellText title={spaceRoleDescription(role, t) ?? role.key}>
            {spaceRoleDescription(role, t) ?? role.key}
          </CellText>
        </span>
      ),
    },
    {
      id: "permissions",
      header: t("roles.permissionsLabel"),
      width: 120,
      align: "end",
      tier: 2,
      cell: (role) => (
        <span className="text-muted-foreground text-xs">
          {t("roles.permissionCount", { count: role.permissions.length })}
        </span>
      ),
    },
    rowActionsColumn((role: RoleObject) =>
      onPreview || canDelete(role) ? (
        <TableRowActions
          menuLabel={t("providers.moreActions", { name: spaceRoleLabel(role, t) ?? role.name })}
          isPending={isDeleting}
          actions={[
            {
              id: "preview",
              label: t("viewAs.rowAction"),
              icon: Eye,
              onSelect: () => onPreview?.(role),
              hidden: !onPreview,
            },
            {
              id: "delete",
              label: t("common:btn.delete"),
              icon: Trash2,
              onSelect: () => onDelete(role),
              disabled: isDeleting,
              destructive: true,
              hidden: !canDelete(role),
            },
          ]}
        />
      ) : null,
    ),
  ];
}
