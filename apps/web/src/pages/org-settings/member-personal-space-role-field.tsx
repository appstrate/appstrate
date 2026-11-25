// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { components } from "../../api/client";
import { SettingRow } from "../../components/settings/setting-row";
import { SpaceRoleSelect } from "../../components/space-role-select";
import { useOrg, useSetMemberPersonalSpaceRole } from "../../hooks/use-org";
import { useOrgSettings } from "../../hooks/use-org-settings";
import { usePermissions } from "../../hooks/use-permissions";
import { spaceRoleValue, useSpaceRoleOptions, type SpaceRoleOption } from "../../hooks/use-roles";
import {
  FOLLOW_ORG_DEFAULT,
  memberOverrideToSelectValue,
  storedRoleToSelectValue,
} from "../../lib/personal-space-role";

type OrgMember = components["schemas"]["OrgMember"];

/**
 * « Rôle dans son espace personnel » of the user sheet: the member's own override, or the
 * organization's default. Owners and admins always administer theirs, so they get a fixed value
 * and no control; everyone else's is a select for `members:change-role`, a plain line otherwise.
 */
export function PersonalSpaceRoleField({ member }: { member: OrgMember }) {
  const { t } = useTranslation("settings");
  const { can } = usePermissions();
  const label = t("userDetail.personalSpaceRole");

  if (member.role === "owner" || member.role === "admin") {
    return (
      <SettingRow
        label={label}
        description={t("userDetail.personalSpaceRoleAdminHint")}
        className="pb-0"
      >
        <span className="text-sm">{t("userDetail.personalSpaceRoleAdminFixed")}</span>
      </SettingRow>
    );
  }
  return can("members:change-role") ? (
    <EditableField member={member} label={label} />
  ) : (
    <ReadOnlyField member={member} label={label} />
  );
}

/** What « selon l'organisation » resolves to: the org setting, except a guest, who holds `operator`. */
export function followLabel(
  member: OrgMember,
  options: SpaceRoleOption[],
  stored: unknown,
  unknown: string,
): string {
  const value =
    member.role === "guest"
      ? spaceRoleValue({ preset_role: "operator" })
      : storedRoleToSelectValue(stored);
  return options.find((option) => option.value === value)?.label ?? unknown;
}

function EditableField({ member, label }: { member: OrgMember; label: string }) {
  const { t } = useTranslation("settings");
  const { currentOrg } = useOrg();
  const { data: orgSettings, isLoading } = useOrgSettings();
  const { options, isLoading: rolesLoading } = useSpaceRoleOptions();
  const write = useSetMemberPersonalSpaceRole();
  if (!currentOrg) return null;

  const selectOptions: SpaceRoleOption[] = [
    {
      value: FOLLOW_ORG_DEFAULT,
      label: t("userDetail.personalSpaceRoleFollowOrg", {
        role: followLabel(
          member,
          options,
          orgSettings?.personal_space_role,
          t("orgSettings.personalSpaceRoleUnknown"),
        ),
      }),
    },
    ...options,
  ];

  return (
    <SettingRow label={label} description={t("userDetail.personalSpaceRoleHint")} className="pb-0">
      {(labelId) => (
        <SpaceRoleSelect
          id="member-personal-space-role"
          ariaLabelledBy={labelId}
          className="w-64"
          value={memberOverrideToSelectValue(member.personal_space_role)}
          options={selectOptions}
          fallbackLabel={t("orgSettings.personalSpaceRoleUnknown")}
          loading={isLoading || rolesLoading}
          disabled={write.isPending}
          onValueChange={(value) => write.apply(member.userId, value)}
        />
      )}
    </SettingRow>
  );
}

function ReadOnlyField({ member, label }: { member: OrgMember; label: string }) {
  const { t } = useTranslation("settings");
  const { options } = useSpaceRoleOptions();
  const unknown = t("orgSettings.personalSpaceRoleUnknown");
  const override = member.personal_space_role;
  return (
    <SettingRow label={label} className="pb-0">
      <span className="text-sm">
        {override
          ? (options.find((o) => o.value === memberOverrideToSelectValue(override))?.label ??
            unknown)
          : t("userDetail.personalSpaceRoleFollowOrgBare")}
      </span>
    </SettingRow>
  );
}
