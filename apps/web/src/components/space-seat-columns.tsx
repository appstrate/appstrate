// SPDX-License-Identifier: Apache-2.0

/**
 * The `[source, role]` column pair of a person's seat in a space, shared by the
 * space's member list and one person's list of spaces: how they reach it, and
 * as what. The role is the CONTROL when it is the caller's to change and plain
 * text when it is not; owners and admins read as their org role, since
 * `space_members` never holds them.
 */
import { useTranslation } from "react-i18next";
import type { DataColumn } from "./data-table";
import { CellText } from "./table-cells";
import { SpaceRoleSelect } from "./space-role-select";
import { roleI18nKey } from "../hooks/use-permissions";
import {
  memberRoleValue,
  spaceRoleLabel,
  type RoleObject,
  type SpaceRoleOption,
} from "../hooks/use-roles";
import type { SpaceSeat } from "../hooks/use-space-members";

export function useSpaceSeatColumns<Row>({
  seat,
  seatName,
  editable,
  roles,
  roleOptions,
  isChangingRole,
  onChangeRole,
}: {
  seat: (row: Row) => SpaceSeat;
  /** Names the row for the role control's accessible label. */
  seatName: (row: Row) => string;
  /** Whether this row's role is the caller's to change. */
  editable: (row: Row) => boolean;
  roles: RoleObject[] | undefined;
  roleOptions: SpaceRoleOption[];
  isChangingRole: boolean;
  onChangeRole: (row: Row, value: string) => void;
}): DataColumn<Row>[] {
  const { t } = useTranslation(["settings", "common"]);

  const heldRole = (row: Row) => spaceRoleLabel(seat(row).role, t) ?? t("spaceMembers.noRole");
  /** What a role the caller cannot change reads as. */
  const fixedRole = (row: Row) => {
    const { source, org_role } = seat(row);
    return source === "org_role"
      ? t("spaceMembers.orgRoleOf", { role: t(roleI18nKey(org_role)) })
      : heldRole(row);
  };

  return [
    {
      id: "source",
      header: t("spaceMembers.colSource"),
      width: "110px",
      tier: 2,
      cell: (row) => <CellText>{t(`spaceMembers.source.${seat(row).source}`)}</CellText>,
    },
    {
      id: "role",
      header: t("spaceMembers.colRole"),
      width: "minmax(120px,1fr)",
      // A select: it scrolls into reach rather than waiting for room.
      control: true,
      cell: (row) =>
        editable(row) ? (
          <SpaceRoleSelect
            value={memberRoleValue(seat(row).role, roles) ?? `current:${seat(row).role?.key}`}
            options={roleOptions}
            fallbackLabel={heldRole(row)}
            placeholder={t("spaceMembers.noRole")}
            className="h-7 w-full text-xs"
            ariaLabel={t("spaceMembers.roleAriaLabel", { name: seatName(row) })}
            disabled={isChangingRole}
            onValueChange={(value) => onChangeRole(row, value)}
          />
        ) : (
          <CellText title={fixedRole(row)}>{fixedRole(row)}</CellText>
        ),
    },
  ];
}
