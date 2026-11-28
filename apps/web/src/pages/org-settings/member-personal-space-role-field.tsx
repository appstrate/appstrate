// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { components } from "../../api/client";
import { SettingRow } from "../../components/settings/setting-row";
import { SpaceRoleSelect } from "../../components/space-role-select";
import { useOrg, useSetMemberPersonalSpaceRole } from "../../hooks/use-org";
import { usePermissions } from "../../hooks/use-permissions";
import { useSpaceRoleOptions } from "../../hooks/use-roles";
import {
  FOLLOW_ORG_DEFAULT,
  followLabel,
  guestRoleValues,
  memberOverrideToSelectValue,
} from "../../lib/personal-space-role";

type OrgMember = components["schemas"]["OrgMember"];

/**
 * « Rôle dans son espace personnel » of the user sheet, for a caller holding `members:change-role`
 * (the API returns the override to nobody else). Owners and admins always administer theirs.
 */
export function PersonalSpaceRoleField({ member }: { member: OrgMember }) {
  const { t } = useTranslation("settings");
  const { can } = usePermissions();
  const { currentOrg } = useOrg();
  const label = t("userDetail.personalSpaceRole");

  if (!currentOrg || !can("members:change-role")) return null;
  if (member.role === "owner" || member.role === "admin") {
    return (
      <SettingRow
        label={label}
        description={t("userDetail.personalSpaceRoleAdminHint")}
        className="pb-0"
      >
        <span className="text-sm">{t("roles.preset.admin")}</span>
      </SettingRow>
    );
  }
  return <EditableField orgId={currentOrg.id} member={member} label={label} />;
}

function EditableField({
  orgId,
  member,
  label,
}: {
  orgId: string;
  member: OrgMember;
  label: string;
}) {
  const { t } = useTranslation("settings");
  const { options, roles, isLoading: rolesLoading } = useSpaceRoleOptions();
  const write = useSetMemberPersonalSpaceRole();
  const value = memberOverrideToSelectValue(member.personal_space_role);
  const guestValues = member.role === "guest" ? guestRoleValues(roles) : null;

  return (
    <SettingRow label={label} description={t("userDetail.personalSpaceRoleHint")} className="pb-0">
      {(labelId) => (
        <SpaceRoleSelect
          id="member-personal-space-role"
          ariaLabelledBy={labelId}
          className="w-full sm:w-auto sm:max-w-full sm:min-w-56"
          value={value}
          options={[
            {
              value: FOLLOW_ORG_DEFAULT,
              label: t("userDetail.personalSpaceRoleFollowOrg", { role: followLabel(member, t) }),
            },
            ...options.filter(
              (option) => !guestValues || option.value === value || guestValues.has(option.value),
            ),
          ]}
          fallbackLabel={t("orgSettings.personalSpaceRoleUnknown")}
          loading={rolesLoading}
          disabled={write.isPending}
          onValueChange={(next) => write.apply(orgId, member.userId, next)}
        />
      )}
    </SettingRow>
  );
}
