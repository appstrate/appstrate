// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import type { DataColumn } from "../components/data-table";
import { TableRowActions } from "../components/table-row-actions";
import { EndUserAvatar } from "../components/end-user-avatar";
import type { EndUserInfo } from "../hooks/use-end-users";
import { formatDateField } from "../lib/markdown";

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

  return [
    {
      id: "name",
      header: t("applications.endUserName"),
      width: "minmax(100px,1.2fr)",
      cell: (user) => (
        <div className="flex min-w-0 items-center gap-2">
          <EndUserAvatar user={user} />
          <span className="truncate font-medium">
            {endUserDisplayName(user, t("applications.anonymousUser"))}
          </span>
        </div>
      ),
    },
    {
      id: "email",
      header: t("applications.endUserEmail"),
      width: "minmax(100px,1.2fr)",
      tier: 2,
      cell: (user) => (
        <span className="text-muted-foreground block truncate text-xs">{user.email ?? ""}</span>
      ),
    },
    {
      id: "externalId",
      header: t("applications.endUserExternalIdColumn"),
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
      header: t("applications.createdAtColumn"),
      width: "104px",
      tier: 2,
      align: "end",
      cell: (user) => (
        <span className="text-muted-foreground text-xs">
          {formatDateField(user.createdAt, "date")}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      width: "80px",
      align: "end",
      cell: (user) => (
        <TableRowActions
          primary={{ label: t("common:btn.edit"), onSelect: () => onEdit(user) }}
          menuLabel={t("applications.moreEndUserActions", {
            name: endUserDisplayName(user, t("applications.anonymousUser")),
          })}
          isPending={deletingUserId === user.id}
          pendingLabel={t("common:loading")}
        >
          <DropdownMenuItem
            onSelect={() => onDelete(user)}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 />
            {t("common:btn.delete")}
          </DropdownMenuItem>
        </TableRowActions>
      ),
    },
  ];
}
