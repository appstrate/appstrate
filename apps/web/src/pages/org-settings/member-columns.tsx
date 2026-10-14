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
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import type { components } from "../../api/schema";
import type { DataColumn } from "../../components/data-table";
import { roleI18nKey } from "../../hooks/use-permissions";
import { formatDateField } from "../../lib/format-date";
import type { OrgRole } from "@appstrate/shared-types";
import { TableRowActions } from "../../components/table-row-actions";

/** Widest reach first, the order every org-role list uses. Only an owner is offered `owner`. */
const ORG_ROLE_DISPLAY_ORDER: readonly OrgRole[] = ["owner", "admin", "member", "guest"];

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
      header: t("orgSettings.memberColumn"),
      width: "minmax(130px,1.4fr)",
      cell: (member) => {
        const name = member.displayName || member.email || member.userId;
        return (
          <span className="block truncate text-sm font-medium" title={name}>
            {name}
          </span>
        );
      },
    },
    {
      id: "email",
      header: t("orgSettings.emailColumn"),
      width: "minmax(150px,1.3fr)",
      tier: 2,
      cell: (member) => (
        <span
          className="text-muted-foreground block truncate text-xs"
          title={member.email ?? undefined}
        >
          {member.email ?? "—"}
        </span>
      ),
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
          return (
            <span className="text-muted-foreground block truncate text-xs">
              {t(roleI18nKey(member.role))}
            </span>
          );
        }
        return (
          // The row's stretched link paints over its cells: a control has to
          // raise itself to stay clickable.
          <span className="relative z-10 block">
            <Select
              value={member.role}
              onValueChange={(v) => onChangeRole(member, v as OrgRole)}
              disabled={isChangingRole}
            >
              <SelectTrigger className="h-7 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ORG_ROLE_DISPLAY_ORDER.filter((r) => roles.includes(r)).map((r) => (
                  <SelectItem key={r} value={r}>
                    {t(roleI18nKey(r))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </span>
        );
      },
    },
    ...(spaces
      ? [
          {
            id: "spaces",
            header: t("orgSettings.spacesColumn"),
            width: "minmax(100px,1.2fr)" as const,
            tier: 3 as const,
            cell: (member: OrgMember) => {
              const names = spaces(member);
              if (names.length === 0)
                return <span className="text-muted-foreground text-xs">—</span>;
              const text = names.join(", ");
              return (
                <span
                  className="text-muted-foreground relative z-10 block truncate text-xs"
                  title={text}
                >
                  {text}
                </span>
              );
            },
          },
        ]
      : []),
    {
      id: "joined",
      header: t("orgSettings.joinedColumn"),
      width: "92px",
      align: "end",
      tier: 3,
      cell: (member) => (
        <span className="text-muted-foreground text-xs">
          {member.joinedAt ? formatDateField(member.joinedAt, "date") : "—"}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      width: "48px",
      align: "end",
      cell: (member) =>
        canRemove(member) ? (
          <TableRowActions
            menuLabel={t("orgSettings.moreMemberActions", {
              name: member.displayName || member.email || member.userId,
            })}
            isPending={isRemoving}
            pendingLabel={t("common:loading")}
          >
            <DropdownMenuItem
              onSelect={() => onRemove(member)}
              disabled={isRemoving}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 />
              {t("btn.remove")}
            </DropdownMenuItem>
          </TableRowActions>
        ) : null,
    },
  ];
}
