// SPDX-License-Identifier: Apache-2.0

/**
 * The pending-invitation column set.
 *
 * An invitation is a record like a member is — the same fields in the same
 * order on every row — so it takes the table rather than the stacked card that
 * reprinted "Accès à l'organisation" and "Rôles dans les espaces" on each one.
 * Editing is the one frequent deed and stays direct; copying the link and
 * cancelling live in the menu, cancelling last because it is destructive.
 *
 * Out of the table component so `column-tiers.test.tsx` can measure it.
 */
import { useTranslation } from "react-i18next";
import { Link2, Trash2 } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@appstrate/ui/components/dropdown-menu";
import type { components } from "../api/schema";
import type { DataColumn } from "./data-table";
import { TableRowActions } from "./table-row-actions";
import { roleI18nKey } from "../hooks/use-permissions";
import { formatDateField } from "../lib/format-date";

type Invitation = components["schemas"]["OrgInvitationInfo"];

export function useInvitationColumns({
  assignments,
  canEdit,
  isCanceling,
  onEdit,
  onCopyLink,
  onCancel,
}: {
  /** "Space · Role" for each space the invitation assigns. */
  assignments: (invitation: Invitation) => string[];
  canEdit: boolean;
  isCanceling: boolean;
  onEdit: (invitation: Invitation) => void;
  onCopyLink: (invitation: Invitation) => void;
  onCancel: (invitation: Invitation) => void;
}): DataColumn<Invitation>[] {
  const { t } = useTranslation(["settings", "common"]);

  return [
    {
      id: "email",
      header: t("orgSettings.emailColumn"),
      width: "minmax(120px,1.4fr)",
      cell: (invitation) => (
        <span className="block truncate text-sm font-medium">{invitation.email}</span>
      ),
    },
    {
      id: "role",
      header: t("orgSettings.roleColumn"),
      width: "minmax(100px,1fr)",
      tier: 2,
      cell: (invitation) => (
        <span className="text-muted-foreground block truncate text-xs">
          {t(roleI18nKey(invitation.role))}
        </span>
      ),
    },
    {
      id: "spaces",
      header: t("orgSettings.inviteSpacesLabel"),
      width: "minmax(80px,1.3fr)",
      tier: 2,
      cell: (invitation) => {
        const list = assignments(invitation);
        if (list.length === 0) return <span className="text-muted-foreground text-xs">—</span>;
        const text = list.join(", ");
        return (
          <span className="text-muted-foreground relative z-10 block truncate text-xs" title={text}>
            {text}
          </span>
        );
      },
    },
    {
      id: "expires",
      header: t("orgSettings.expiresColumn"),
      width: "92px",
      align: "end",
      tier: 2,
      cell: (invitation) => (
        <span className="text-muted-foreground text-xs">
          {formatDateField(invitation.expiresAt, "date")}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      width: "80px",
      align: "end",
      cell: (invitation) => (
        <TableRowActions
          primary={
            canEdit
              ? { label: t("orgSettings.editInvitation"), onSelect: () => onEdit(invitation) }
              : undefined
          }
          menuLabel={t("orgSettings.moreInvitationActions", { email: invitation.email })}
          isPending={isCanceling}
          pendingLabel={t("common:loading")}
        >
          <DropdownMenuItem onSelect={() => onCopyLink(invitation)}>
            <Link2 />
            {t("common:btn.copyLink")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => onCancel(invitation)}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 />
            {t("orgSettings.cancelInvitation")}
          </DropdownMenuItem>
        </TableRowActions>
      ),
    },
  ];
}
