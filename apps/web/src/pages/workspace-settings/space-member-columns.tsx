// SPDX-License-Identifier: Apache-2.0

/**
 * The space-members column set — the organization Users table's twin.
 *
 * Same record, same order, same treatment: who, their address, then how they
 * reach this space and as what. The role column holds the CONTROL when the
 * role is the caller's to change and plain text when it is not; owners and
 * admins read as their org role, since `space_members` never holds them.
 * Removing an explicit seat is the one deed, and it lives in the menu: for a
 * member of an open space it restores the default role rather than cutting
 * access, and the menu says which.
 *
 * Out of the page, as data.
 */
import { useTranslation } from "react-i18next";
import { RotateCcw, Trash2 } from "lucide-react";
import type { DataColumn } from "../../components/data-table";
import { TableRowActions } from "../../components/table-row-actions";
import { rowActionsColumn } from "../../components/row-actions-column";
import { CellEmpty, CellText } from "../../components/table-cells";
import { useSpaceSeatColumns } from "../../components/space-seat-columns";
import type { RoleObject, SpaceRoleOption } from "../../hooks/use-roles";
import { memberLabel } from "../../lib/members";
import type { SpaceMemberObject } from "../../hooks/use-space-members";

export function useSpaceMemberColumns({
  editable,
  roles,
  roleOptions,
  isChangingRole,
  onChangeRole,
  removal,
  isRemoving,
  removeDisabled,
  onRemove,
}: {
  /** Whether this row's role is the caller's to change. */
  editable: (member: SpaceMemberObject) => boolean;
  roles: RoleObject[] | undefined;
  roleOptions: SpaceRoleOption[];
  isChangingRole: boolean;
  onChangeRole: (member: SpaceMemberObject, value: string) => void;
  /** What removing the seat does, or `null` when it is not the caller's to remove. */
  removal: (member: SpaceMemberObject) => "reset" | "remove" | null;
  isRemoving: boolean;
  removeDisabled: boolean;
  onRemove: (member: SpaceMemberObject) => void;
}): DataColumn<SpaceMemberObject>[] {
  const { t } = useTranslation(["settings", "common"]);
  const seatColumns = useSpaceSeatColumns<SpaceMemberObject>({
    seat: (member) => member,
    seatName: memberLabel,
    editable,
    roles,
    roleOptions,
    isChangingRole,
    onChangeRole,
  });

  return [
    {
      id: "member",
      header: t("spaceMembers.colMember"),
      width: 100,
      elastic: true,
      cell: (member) => (
        <CellText strong title={memberLabel(member)}>
          {memberLabel(member)}
        </CellText>
      ),
    },
    {
      id: "email",
      header: t("orgSettings.emailColumn"),
      width: 100,
      elastic: true,
      tier: 2,
      cell: (member) =>
        member.email ? <CellText title={member.email}>{member.email}</CellText> : <CellEmpty />,
    },
    ...seatColumns,
    rowActionsColumn((member: SpaceMemberObject) => {
      const kind = removal(member);
      if (!kind) return null;
      return (
        <TableRowActions
          menuLabel={t("providers.moreActions", { name: memberLabel(member) })}
          isPending={isRemoving}
          actions={[
            {
              id: kind,
              label: t(kind === "reset" ? "spaceMembers.resetRole" : "spaceMembers.removeAccess"),
              icon: kind === "reset" ? RotateCcw : Trash2,
              onSelect: () => onRemove(member),
              disabled: removeDisabled,
              destructive: kind === "remove",
            },
          ]}
        />
      );
    }),
  ];
}
