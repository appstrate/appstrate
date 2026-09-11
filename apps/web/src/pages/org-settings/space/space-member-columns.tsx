// SPDX-License-Identifier: Apache-2.0

/**
 * The space-members column set — the organisation Users table's twin.
 *
 * Same record, same order, same treatment: who, their address, then how they
 * reach this space and as what. The role column holds the CONTROL when the
 * role is the caller's to change and plain text when it is not; owners and
 * admins read as their org role, since `space_members` never holds them.
 * Removing an explicit seat is the one deed, and it lives in the menu: for a
 * member of an open space it restores the default role rather than cutting
 * access, and the menu says which.
 *
 * Out of the page so `column-tiers.test.tsx` can measure it.
 */
import { useTranslation } from "react-i18next";
import { RotateCcw, Trash2 } from "lucide-react";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import type { DataColumn } from "../../../components/data-table";
import { TableRowActions } from "../../../components/table-row-actions";
import { SpaceRoleSelect } from "../../../components/space-role-select";
import { roleI18nKey } from "../../../hooks/use-permissions";
import { spaceRoleLabel, type useSpaceRoleOptions } from "../../../hooks/use-roles";
import type { SpaceMemberObject } from "../../../hooks/use-space-members";

type SpaceRoleOption = ReturnType<typeof useSpaceRoleOptions>["options"][number];

function memberLabel(member: SpaceMemberObject): string {
  return member.name || member.email || member.userId;
}

export function useSpaceMemberColumns({
  editable,
  roleValue,
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
  roleValue: (member: SpaceMemberObject) => string;
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

  return [
    {
      id: "member",
      header: t("spaceMembers.colMember"),
      width: "minmax(100px,1.4fr)",
      cell: (member) => (
        <span className="block truncate text-sm font-medium">{memberLabel(member)}</span>
      ),
    },
    {
      id: "email",
      header: t("orgSettings.emailColumn"),
      width: "minmax(100px,1.3fr)",
      tier: 2,
      cell: (member) => (
        <span className="text-muted-foreground block truncate text-xs">{member.email ?? "—"}</span>
      ),
    },
    {
      id: "source",
      header: t("spaceMembers.colSource"),
      width: "110px",
      tier: 2,
      cell: (member) => (
        <span className="text-muted-foreground block truncate text-xs">
          {t(`spaceMembers.source.${member.source}`)}
        </span>
      ),
    },
    {
      id: "role",
      header: t("spaceMembers.colRole"),
      width: "minmax(110px,1fr)",
      tier: 2,
      cell: (member) =>
        editable(member) ? (
          <SpaceRoleSelect
            value={roleValue(member)}
            options={roleOptions}
            fallbackLabel={spaceRoleLabel(member.role, t) ?? t("spaceMembers.noRole")}
            placeholder={t("spaceMembers.noRole")}
            className="h-7 w-full text-xs"
            ariaLabel={t("spaceMembers.roleAriaLabel", { name: memberLabel(member) })}
            disabled={isChangingRole}
            onValueChange={(value) => onChangeRole(member, value)}
          />
        ) : (
          <span className="text-muted-foreground block truncate text-xs">
            {member.source === "org_role"
              ? t("spaceMembers.orgRoleOf", { role: t(roleI18nKey(member.org_role)) })
              : (spaceRoleLabel(member.role, t) ?? t("spaceMembers.noRole"))}
          </span>
        ),
    },
    {
      id: "actions",
      header: "",
      width: "48px",
      align: "end",
      cell: (member) => {
        const kind = removal(member);
        if (!kind) return null;
        return (
          <TableRowActions
            menuLabel={t("spaceMembers.moreActions", { name: memberLabel(member) })}
            isPending={isRemoving}
            pendingLabel={t("common:loading")}
          >
            <DropdownMenuItem
              onSelect={() => onRemove(member)}
              disabled={removeDisabled}
              className={kind === "remove" ? "text-destructive focus:text-destructive" : undefined}
            >
              {kind === "reset" ? <RotateCcw /> : <Trash2 />}
              {t(kind === "reset" ? "spaceMembers.resetRole" : "spaceMembers.removeAccess")}
            </DropdownMenuItem>
          </TableRowActions>
        );
      },
    },
  ];
}
