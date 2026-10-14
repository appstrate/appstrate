// SPDX-License-Identifier: Apache-2.0

/**
 * One person's spaces, inside their detail: the space, how they reach it, and
 * as what. The role is the CONTROL when it is the caller's to change, which is
 * what makes this modal the place to manage someone's access rather than a
 * report about it.
 *
 * Out of the modal so `column-tiers.test.tsx` can measure it.
 */
import { useTranslation } from "react-i18next";
import type { DataColumn } from "../../components/data-table";
import { CellText } from "../../components/table-cells";
import { SpaceRoleSelect } from "../../components/space-role-select";
import { roleI18nKey } from "../../hooks/use-permissions";
import { spaceRoleLabel, type useSpaceRoleOptions } from "../../hooks/use-roles";
import type { OrgRole } from "@appstrate/shared-types";
import type { components } from "../../api/client";

type OrgMemberSpace = components["schemas"]["OrgMemberSpace"];
type SpaceRoleOption = ReturnType<typeof useSpaceRoleOptions>["options"][number];

export function useUserSpaceColumns({
  orgRole,
  editable,
  roleValue,
  roleOptions,
  isChangingRole,
  onChangeRole,
}: {
  /** The person's org role: what a space reached through it reads as. */
  orgRole: OrgRole;
  editable: (space: OrgMemberSpace) => boolean;
  roleValue: (space: OrgMemberSpace) => string;
  roleOptions: SpaceRoleOption[];
  isChangingRole: boolean;
  onChangeRole: (space: OrgMemberSpace, value: string) => void;
}): DataColumn<OrgMemberSpace>[] {
  const { t } = useTranslation(["settings", "common"]);
  /** What a role the caller cannot change reads as. */
  const fixedRole = (space: OrgMemberSpace) =>
    space.source === "org_role"
      ? t("spaceMembers.orgRoleOf", { role: t(roleI18nKey(orgRole)) })
      : (spaceRoleLabel(space.role, t) ?? t("spaceMembers.noRole"));

  return [
    {
      id: "space",
      header: t("userDetail.colSpace"),
      width: "minmax(120px,1.4fr)",
      cell: (space) => (
        <CellText strong title={space.name}>
          {space.name}
        </CellText>
      ),
    },
    {
      id: "access",
      header: t("spaceMembers.colSource"),
      width: "110px",
      tier: 2,
      cell: (space) => <CellText>{t(`spaceMembers.source.${space.source}`)}</CellText>,
    },
    {
      id: "role",
      header: t("spaceMembers.colRole"),
      width: "minmax(120px,1fr)",
      control: true,
      cell: (space) =>
        editable(space) ? (
          <SpaceRoleSelect
            value={roleValue(space)}
            options={roleOptions}
            fallbackLabel={spaceRoleLabel(space.role, t) ?? t("spaceMembers.noRole")}
            placeholder={t("spaceMembers.noRole")}
            className="h-7 w-full text-xs"
            ariaLabel={t("spaceMembers.roleAriaLabel", { name: space.name })}
            disabled={isChangingRole}
            onValueChange={(value) => onChangeRole(space, value)}
          />
        ) : (
          <CellText title={fixedRole(space)}>{fixedRole(space)}</CellText>
        ),
    },
  ];
}
