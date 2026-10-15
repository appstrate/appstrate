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
import { useSpaceSeatColumns } from "../../components/space-seat-columns";
import type { RoleObject, SpaceRoleOption } from "../../hooks/use-roles";
import type { components } from "../../api/client";

type OrgMember = components["schemas"]["OrgMember"];
type OrgMemberSpace = components["schemas"]["OrgMemberSpace"];

export function useUserSpaceColumns({
  member,
  editable,
  roles,
  roleOptions,
  isChangingRole,
  onChangeRole,
}: {
  /** The person whose spaces these are; their org role is what an `org_role` seat reads as. */
  member: Pick<OrgMember, "userId" | "role">;
  editable: (space: OrgMemberSpace) => boolean;
  roles: RoleObject[] | undefined;
  roleOptions: SpaceRoleOption[];
  isChangingRole: boolean;
  onChangeRole: (space: OrgMemberSpace, value: string) => void;
}): DataColumn<OrgMemberSpace>[] {
  const { t } = useTranslation(["settings", "common"]);
  const seatColumns = useSpaceSeatColumns<OrgMemberSpace>({
    seat: (space) => ({
      userId: member.userId,
      org_role: member.role,
      source: space.source,
      role: space.role,
    }),
    seatName: (space) => space.name,
    editable,
    roles,
    roleOptions,
    isChangingRole,
    onChangeRole,
  });

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
    ...seatColumns,
  ];
}
