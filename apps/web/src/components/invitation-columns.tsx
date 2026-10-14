// SPDX-License-Identifier: Apache-2.0

/**
 * The pending-invitation column set.
 *
 * An invitation is a record like a member is — the same fields in the same
 * order on every row — so it takes the table rather than a stacked card
 * reprinting "Accès à l'organisation" and "Rôles dans les espaces" on each one.
 * Editing is what a click on the row does, and it is the menu's first entry;
 * copying the link and cancelling follow, cancelling last because it is
 * destructive.
 *
 * Out of the table component so `column-tiers.test.tsx` can measure it.
 */
import { useTranslation } from "react-i18next";
import { Link2, Pencil, Trash2 } from "lucide-react";
import type { components } from "../api/schema";
import type { DataColumn } from "./data-table";
import { rowActionsColumn } from "./row-actions-column";
import { TableRowActions } from "./table-row-actions";
import { CellDate, CellList, CellText } from "./table-cells";
import { roleI18nKey } from "../hooks/use-permissions";

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
      cell: (invitation) => <CellText strong>{invitation.email}</CellText>,
    },
    {
      id: "role",
      header: t("orgSettings.roleColumn"),
      width: "minmax(100px,1fr)",
      tier: 2,
      cell: (invitation) => <CellText>{t(roleI18nKey(invitation.role))}</CellText>,
    },
    {
      id: "spaces",
      header: t("orgSettings.inviteSpacesLabel"),
      width: "minmax(80px,1.3fr)",
      tier: 2,
      cell: (invitation) => <CellList items={assignments(invitation)} />,
    },
    {
      id: "expires",
      header: t("orgSettings.expiresColumn"),
      width: "92px",
      align: "end",
      tier: 2,
      cell: (invitation) => <CellDate value={invitation.expiresAt} granularity="date" />,
    },
    rowActionsColumn((invitation) => (
      <TableRowActions
        menuLabel={t("orgSettings.moreInvitationActions", { email: invitation.email })}
        isPending={isCanceling}
        actions={[
          {
            id: "edit",
            label: t("orgSettings.editInvitation"),
            icon: Pencil,
            onSelect: () => onEdit(invitation),
            hidden: !canEdit,
          },
          {
            id: "copy-link",
            label: t("common:btn.copyLink"),
            icon: Link2,
            onSelect: () => onCopyLink(invitation),
          },
          {
            id: "cancel",
            label: t("orgSettings.cancelInvitation"),
            icon: Trash2,
            onSelect: () => onCancel(invitation),
            destructive: true,
          },
        ]}
      />
    )),
  ];
}
