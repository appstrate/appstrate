// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Pencil, Trash2 } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@appstrate/ui/components/dropdown-menu";
import type { DataColumn } from "../components/data-table";
import { usePermissions } from "../hooks/use-permissions";
import { TableRowActions } from "../components/table-row-actions";
import { EndUserAvatar } from "../components/end-user-avatar";
import type { EndUserInfo } from "../hooks/use-end-users";
import { formatDateField } from "../lib/format-date";

export function endUserDisplayName(user: EndUserInfo, anonymousLabel: string): string {
  return user.name || user.email || user.externalId || anonymousLabel;
}

/** One comparable end-user fact per desktop column; identity and actions survive on phones. */
export function useEndUserColumns({
  deletingUserId,
  onEdit,
  onDelete,
}: {
  deletingUserId: string | null;
  onEdit: (user: EndUserInfo) => void;
  onDelete: (user: EndUserInfo) => void;
}): DataColumn<EndUserInfo>[] {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  // Each deed is offered to whoever the route grants it (PATCH `end-users:write`,
  // DELETE `end-users:delete`); a row with neither has no actions column.
  const canEdit = can("end-users:write");
  const canDelete = can("end-users:delete");

  const columns: DataColumn<EndUserInfo>[] = [
    {
      id: "name",
      header: t("spaces.endUserName"),
      width: "minmax(100px,1.2fr)",
      cell: (user) => (
        <div className="flex min-w-0 items-center gap-2">
          <EndUserAvatar user={user} />
          <span className="truncate font-medium">
            {endUserDisplayName(user, t("spaces.anonymousUser"))}
          </span>
        </div>
      ),
    },
    {
      id: "email",
      header: t("spaces.endUserEmail"),
      width: "minmax(100px,1.2fr)",
      tier: 2,
      cell: (user) => (
        <span className="text-muted-foreground block truncate text-xs">{user.email ?? ""}</span>
      ),
    },
    {
      id: "externalId",
      header: t("spaces.endUserExternalId"),
      width: "minmax(80px,1fr)",
      tier: 2,
      cell: (user) => (
        <span className="text-muted-foreground block truncate font-mono text-xs">
          {user.externalId ?? ""}
        </span>
      ),
    },
    {
      id: "createdAt",
      header: t("spaces.createdAtLabel"),
      width: "104px",
      tier: 2,
      align: "end",
      cell: (user) => (
        <span className="text-muted-foreground text-xs">
          {formatDateField(user.createdAt, "date")}
        </span>
      ),
    },
  ];
  if (!canEdit && !canDelete) return columns;
  return [
    ...columns,
    {
      id: "actions",
      header: "",
      width: "80px",
      align: "end",
      cell: (user) => (
        <TableRowActions
          menuLabel={t("spaces.moreEndUserActions", {
            name: endUserDisplayName(user, t("spaces.anonymousUser")),
          })}
          isPending={deletingUserId === user.id}
        >
          {canEdit && (
            <DropdownMenuItem onSelect={() => onEdit(user)}>
              <Pencil />
              {t("common:btn.edit")}
            </DropdownMenuItem>
          )}
          {canEdit && canDelete && <DropdownMenuSeparator />}
          {canDelete && (
            <DropdownMenuItem
              onSelect={() => onDelete(user)}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 />
              {t("common:btn.delete")}
            </DropdownMenuItem>
          )}
        </TableRowActions>
      ),
    },
  ];
}
