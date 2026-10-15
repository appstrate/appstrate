// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Pencil, Trash2 } from "lucide-react";
import type { DataColumn } from "../components/data-table";
import { usePermissions } from "../hooks/use-permissions";
import { rowActionsColumn } from "../components/row-actions-column";
import { TableRowActions } from "../components/table-row-actions";
import { CellDate, CellText } from "../components/table-cells";
import { EndUserAvatar } from "../components/end-user-avatar";
import { endUserLabel } from "../lib/members";
import type { EndUserInfo } from "../hooks/use-end-users";

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
            {endUserLabel(user, t("spaces.anonymousUser"))}
          </span>
        </div>
      ),
    },
    {
      id: "email",
      header: t("spaces.endUserEmail"),
      width: "minmax(100px,1.2fr)",
      tier: 2,
      cell: (user) => <CellText>{user.email ?? ""}</CellText>,
    },
    {
      id: "externalId",
      header: t("spaces.endUserExternalId"),
      width: "minmax(80px,1fr)",
      tier: 2,
      cell: (user) => <CellText mono>{user.externalId ?? ""}</CellText>,
    },
    {
      id: "createdAt",
      header: t("spaces.createdAtLabel"),
      width: "104px",
      tier: 2,
      align: "end",
      cell: (user) => <CellDate value={user.createdAt} granularity="date" />,
    },
  ];
  if (!canEdit && !canDelete) return columns;
  return [
    ...columns,
    rowActionsColumn((user) => (
      <TableRowActions
        menuLabel={t("spaces.moreEndUserActions", {
          name: endUserLabel(user, t("spaces.anonymousUser")),
        })}
        isPending={deletingUserId === user.id}
        actions={[
          {
            id: "edit",
            label: t("common:btn.edit"),
            icon: Pencil,
            onSelect: () => onEdit(user),
            hidden: !canEdit,
          },
          {
            id: "delete",
            label: t("common:btn.delete"),
            icon: Trash2,
            onSelect: () => onDelete(user),
            destructive: true,
            hidden: !canDelete,
          },
        ]}
      />
    )),
  ];
}
