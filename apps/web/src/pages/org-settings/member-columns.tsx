// SPDX-License-Identifier: Apache-2.0

/**
 * The members column set.
 *
 * A settings list is a list of RECORDS: the same fields, in the same order, on
 * every row. That is the table's bargain — alignment across rows, paid for in
 * width — and drawing it as stacked cards instead meant every row reprinted its
 * own labels. The CLI sessions card was the clearest case (four labels repeated
 * per row where a head writes them once), but members had the same shape.
 *
 * The move to a table settled something the card had left crooked: the role was
 * drawn TWICE, as a badge in the header and as a `Select` in a footer strip.
 * One column now, and it holds the CONTROL when the actor may change the role,
 * falling back to the badge when they may not — "the control IS the setting",
 * which a value with a picker beside it is not.
 *
 * Out of the page for the same reason as `model-columns.tsx`: a column set is
 * data, and it has to be reachable by `column-tiers.test.tsx`.
 */

import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
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
import { formatDateField } from "../../lib/markdown";
import type { AssignableOrgRole } from "@appstrate/shared-types";

type OrgMember = components["schemas"]["OrgMember"];

export function useMemberColumns({
  assignableRoles,
  canRemove,
  isChangingRole,
  isRemoving,
  onChangeRole,
  onRemove,
}: {
  /** Which roles this actor may move that member to. Empty = not theirs to change. */
  assignableRoles: (member: OrgMember) => readonly AssignableOrgRole[];
  canRemove: (member: OrgMember) => boolean;
  isChangingRole: boolean;
  isRemoving: boolean;
  onChangeRole: (userId: string, role: AssignableOrgRole) => void;
  onRemove: (member: OrgMember) => void;
}): DataColumn<OrgMember>[] {
  const { t } = useTranslation(["settings", "common"]);

  return [
    {
      id: "member",
      header: t("orgSettings.memberColumn"),
      width: "minmax(160px,1.6fr)",
      cell: (member) => (
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {member.displayName || member.email || member.userId}
          </div>
          {member.email && (
            <div className="text-muted-foreground truncate text-xs">{member.email}</div>
          )}
        </div>
      ),
    },
    {
      id: "role",
      header: t("orgSettings.roleColumn"),
      width: "132px",
      cell: (member) => {
        const roles = assignableRoles(member);
        if (roles.length === 0) {
          return (
            <Badge
              variant={
                member.role === "owner"
                  ? "running"
                  : member.role === "admin"
                    ? "success"
                    : "pending"
              }
            >
              {t(roleI18nKey(member.role))}
            </Badge>
          );
        }
        return (
          <Select
            value={member.role}
            onValueChange={(v) => onChangeRole(member.userId, v as AssignableOrgRole)}
            disabled={isChangingRole}
          >
            <SelectTrigger className="h-7 w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {roles.map((r) => (
                <SelectItem key={r} value={r}>
                  {t(roleI18nKey(r))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      },
    },
    {
      id: "joined",
      header: t("orgSettings.joinedColumn"),
      width: "132px",
      align: "end",
      // Tier 2, NOT 3. This table lives in the settings dialog, which tops out
      // around 800px, so it never crosses the 56rem threshold at all: a column
      // parked in tier 3 here is not "shown later", it is never shown. The same
      // trap the models table fell into.
      tier: 2,
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
      // Removing a member is desk work; who they are and what they may do is
      // what a narrow table owes the reader.
      tier: 2,
      cell: (member) =>
        canRemove(member) ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => onRemove(member)}
            disabled={isRemoving}
            aria-label={t("btn.remove")}
          >
            <Trash2 size={14} className="text-destructive" />
          </Button>
        ) : null,
    },
  ];
}
