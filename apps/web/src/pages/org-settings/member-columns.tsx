// SPDX-License-Identifier: Apache-2.0

/**
 * The members column set.
 *
 * A settings list is a list of RECORDS: the same fields, in the same order, on
 * every row. That is the table's bargain — alignment across rows, paid for in
 * width — and drawing it as stacked cards instead would make every row reprint
 * its own labels (a head writes them once).
 *
 * The role is drawn ONCE, not as a badge in a header beside a `Select` in a
 * footer strip: one column, and it holds the CONTROL when the actor may change
 * the role, falling back to plain text when they may not — "the control IS the setting",
 * which a value with a picker beside it is not.
 *
 * Out of the page for the same reason as `model-columns.tsx`: a column set is
 * data, and it has to be reachable by `column-tiers.test.tsx`.
 */

import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import type { components } from "../../api/schema";
import type { DataColumn } from "../../components/data-table";
import { roleI18nKey } from "../../hooks/use-permissions";
import { memberLabel } from "../../lib/members";
import type { OrgRole } from "@appstrate/shared-types";
import { OrgRoleSelect } from "../../components/org-role-select";
import { TableRowActions } from "../../components/table-row-actions";
import { rowActionsColumn } from "../../components/row-actions-column";
import { CellDate, CellEmpty, CellList, CellText } from "../../components/table-cells";

type OrgMember = components["schemas"]["OrgMember"];

export function useMemberColumns({
  assignableRoles,
  canRemove,
  isChangingRole,
  isRemoving,
  onChangeRole,
  onRemove,
  spaces,
}: {
  /** Which roles this actor may move that member to. Empty = not theirs to change. */
  assignableRoles: (member: OrgMember) => readonly OrgRole[];
  canRemove: (member: OrgMember) => boolean;
  isChangingRole: boolean;
  isRemoving: boolean;
  onChangeRole: (member: OrgMember, role: OrgRole) => void;
  onRemove: (member: OrgMember) => void;
  /** The spaces this person reaches, when the caller may see every one. */
  spaces?: (member: OrgMember) => string[];
}): DataColumn<OrgMember>[] {
  const { t } = useTranslation(["settings", "common"]);

  return [
    {
      id: "member",
      header: t("spaceMembers.colMember"),
      width: "minmax(130px,1.4fr)",
      cell: (member) => {
        const name = memberLabel(member);
        return (
          <CellText strong title={name}>
            {name}
          </CellText>
        );
      },
    },
    {
      id: "email",
      header: t("orgSettings.emailColumn"),
      width: "minmax(150px,1.3fr)",
      tier: 2,
      cell: (member) =>
        member.email ? <CellText title={member.email}>{member.email}</CellText> : <CellEmpty />,
    },
    {
      id: "role",
      header: t("orgSettings.roleColumn"),
      width: "minmax(140px,1fr)",
      // A select: it scrolls into reach rather than waiting for room.
      control: true,
      cell: (member) => {
        const roles = assignableRoles(member);
        if (roles.length === 0) {
          return <CellText>{t(roleI18nKey(member.role))}</CellText>;
        }
        return (
          // The row's stretched link paints over its cells: a control has to
          // raise itself to stay clickable.
          <span className="relative z-10 block">
            <OrgRoleSelect
              value={member.role}
              roles={roles}
              onValueChange={(role) => onChangeRole(member, role)}
              disabled={isChangingRole}
              className="h-7 w-full text-xs"
              aria-label={t("orgSettings.memberRoleAriaLabel", { name: memberLabel(member) })}
            />
          </span>
        );
      },
    },
    ...(spaces
      ? [
          {
            id: "spaces",
            header: t("orgSettings.inviteSpacesLabel"),
            width: "minmax(100px,1.2fr)" as const,
            tier: 3 as const,
            cell: (member: OrgMember) => <CellList items={spaces(member)} />,
          },
        ]
      : []),
    {
      id: "joined",
      header: t("orgSettings.joinedColumn"),
      width: "92px",
      align: "end",
      tier: 3,
      cell: (member) => <CellDate value={member.joinedAt} granularity="date" />,
    },
    rowActionsColumn((member: OrgMember) =>
      canRemove(member) ? (
        <TableRowActions
          menuLabel={t("providers.moreActions", {
            name: memberLabel(member),
          })}
          isPending={isRemoving}
          actions={[
            {
              id: "remove",
              label: t("btn.remove"),
              icon: Trash2,
              onSelect: () => onRemove(member),
              disabled: isRemoving,
              destructive: true,
            },
          ]}
        />
      ) : null,
    ),
  ];
}
