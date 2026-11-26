// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { components } from "../../api/client";
import { SettingRow } from "../../components/settings/setting-row";
import { SpaceRoleSelect } from "../../components/space-role-select";
import { useSetMemberPersonalSpaceRole } from "../../hooks/use-org";
import { usePermissions } from "../../hooks/use-permissions";
import { useSpaceRoleOptions, type SpaceRoleOption } from "../../hooks/use-roles";
import {
  FOLLOW_ORG_DEFAULT,
  followLabel,
  memberOverrideToSelectValue,
} from "../../lib/personal-space-role";

type OrgMember = components["schemas"]["OrgMember"];

/**
 * « Rôle dans son espace personnel » of the user sheet: the member's own override, or the
 * organization's default. Shown only to a caller holding `members:change-role` — the API returns
 * the override to nobody else. Owners and admins always administer theirs, so they get a fixed
 * value and no control; everyone else's is a select.
 */
export function PersonalSpaceRoleField({ member }: { member: OrgMember }) {
  const { t } = useTranslation("settings");
  const { can } = usePermissions();
  const label = t("userDetail.personalSpaceRole");

  if (!can("members:change-role")) return null;
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
  return <EditableField member={member} label={label} />;
}

function EditableField({ member, label }: { member: OrgMember; label: string }) {
  const { t } = useTranslation("settings");
  const { options, isLoading: rolesLoading } = useSpaceRoleOptions();
  const write = useSetMemberPersonalSpaceRole();

  const selectOptions: SpaceRoleOption[] = [
    {
      value: FOLLOW_ORG_DEFAULT,
      label: t("userDetail.personalSpaceRoleFollowOrg", { role: followLabel(member, t) }),
    },
    ...options,
  ];

  return (
    <SettingRow label={label} description={t("userDetail.personalSpaceRoleHint")} className="pb-0">
      {(labelId) => (
        <SpaceRoleSelect
          id="member-personal-space-role"
          ariaLabelledBy={labelId}
          className="w-full sm:w-56"
          value={memberOverrideToSelectValue(member.personal_space_role)}
          options={selectOptions}
          fallbackLabel={t("orgSettings.personalSpaceRoleUnknown")}
          loading={rolesLoading}
          disabled={write.isPending}
          onValueChange={(value) => write.apply(member.userId, value)}
        />
      )}
    </SettingRow>
  );
}
