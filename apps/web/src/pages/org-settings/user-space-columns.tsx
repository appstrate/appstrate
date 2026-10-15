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
import type { SpaceMembership } from "../../hooks/use-space-memberships";

export function useUserSpaceColumns({
  editable,
  roles,
  roleOptions,
  isChangingRole,
  onChangeRole,
}: {
  editable: (membership: SpaceMembership) => boolean;
  roles: RoleObject[] | undefined;
  roleOptions: SpaceRoleOption[];
  isChangingRole: boolean;
  onChangeRole: (membership: SpaceMembership, value: string) => void;
}): DataColumn<SpaceMembership>[] {
  const { t } = useTranslation(["settings", "common"]);
  const seatColumns = useSpaceSeatColumns<SpaceMembership>({
    seat: ({ member }) => member,
    seatName: ({ space }) => space.name,
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
      cell: ({ space }) => (
        <CellText strong title={space.name}>
          {space.name}
        </CellText>
      ),
    },
    ...seatColumns,
  ];
}
