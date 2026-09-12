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
import { SpaceRoleSelect } from "../../components/space-role-select";
import { roleI18nKey } from "../../hooks/use-permissions";
import { spaceRoleLabel, type useSpaceRoleOptions } from "../../hooks/use-roles";
import type { SpaceMembership } from "../../hooks/use-space-memberships";

type SpaceRoleOption = ReturnType<typeof useSpaceRoleOptions>["options"][number];

export function useUserSpaceColumns({
  editable,
  roleValue,
  roleOptions,
  isChangingRole,
  onChangeRole,
}: {
  editable: (membership: SpaceMembership) => boolean;
  roleValue: (membership: SpaceMembership) => string;
  roleOptions: SpaceRoleOption[];
  isChangingRole: boolean;
  onChangeRole: (membership: SpaceMembership, value: string) => void;
}): DataColumn<SpaceMembership>[] {
  const { t } = useTranslation(["settings", "common"]);

  return [
    {
      id: "space",
      header: t("userDetail.colSpace"),
      width: "minmax(120px,1.4fr)",
      cell: ({ space }) => <span className="block truncate text-sm font-medium">{space.name}</span>,
    },
    {
      id: "access",
      header: t("spaceMembers.colSource"),
      width: "110px",
      tier: 2,
      cell: ({ member }) => (
        <span className="text-muted-foreground block truncate text-xs">
          {t(`spaceMembers.source.${member.source}`)}
        </span>
      ),
    },
    {
      id: "role",
      header: t("spaceMembers.colRole"),
      width: "minmax(120px,1fr)",
      cell: (membership) =>
        editable(membership) ? (
          <SpaceRoleSelect
            value={roleValue(membership)}
            options={roleOptions}
            fallbackLabel={spaceRoleLabel(membership.member.role, t) ?? t("spaceMembers.noRole")}
            placeholder={t("spaceMembers.noRole")}
            className="h-7 w-full text-xs"
            ariaLabel={t("spaceMembers.roleAriaLabel", { name: membership.space.name })}
            disabled={isChangingRole}
            onValueChange={(value) => onChangeRole(membership, value)}
          />
        ) : (
          <span className="text-muted-foreground block truncate text-xs">
            {membership.member.source === "org_role"
              ? t("spaceMembers.orgRoleOf", { role: t(roleI18nKey(membership.member.org_role)) })
              : (spaceRoleLabel(membership.member.role, t) ?? t("spaceMembers.noRole"))}
          </span>
        ),
    },
  ];
}
