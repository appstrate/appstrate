// SPDX-License-Identifier: Apache-2.0

/**
 * One person, and everywhere they reach.
 *
 * The table says which spaces; the question it cannot hold in a cell is "as
 * what", and changing that meant opening each space's Members page in turn.
 * Both live here: the org role at the top, then one row per space with its own
 * role control (`useAssignSpaceRole` does the write).
 */
import { useTranslation } from "react-i18next";
import { AppWindow } from "lucide-react";
import type { OrgRole } from "@appstrate/shared-types";
import type { components } from "../../api/client";
import { DataTable } from "../../components/data-table";
import { Modal } from "../../components/modal";
import { EmptyState } from "../../components/page-states";
import { SettingRow } from "../../components/settings/setting-row";
import { OrgRoleSelect } from "../../components/org-role-select";
import { roleI18nKey } from "../../hooks/use-permissions";
import { useSpaceRoleOptions } from "../../hooks/use-roles";
import { useAssignSpaceRole } from "../../hooks/use-space-members";
import { formatDateField } from "../../lib/format-date";
import { memberLabel } from "../../lib/members";
import { useUserSpaceColumns } from "./user-space-columns";

type OrgMember = components["schemas"]["OrgMember"];

export function UserDetailModal({
  member,
  showSpaces,
  assignableRoles,
  isChangingOrgRole,
  onChangeOrgRole,
  onClose,
}: {
  member: OrgMember;
  /** Only an owner or admin reads every space's member list. */
  showSpaces: boolean;
  assignableRoles: readonly OrgRole[];
  isChangingOrgRole: boolean;
  onChangeOrgRole: (role: OrgRole) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const { options: roleOptions, roles } = useSpaceRoleOptions();
  const { assign, isPending: isChangingSpaceRole } = useAssignSpaceRole(roleOptions);

  const columns = useUserSpaceColumns({
    // Owners and admins reach every space through their org role, so there is
    // no seat to edit; everyone else's is the caller's to change, this caller
    // being an admin everywhere.
    member,
    editable: (space) => space.source !== "org_role" && roleOptions.length > 0,
    roles,
    roleOptions,
    isChangingRole: isChangingSpaceRole,
    onChangeRole: (space, value) =>
      assign(
        {
          spaceId: space.id,
          member: {
            userId: member.userId,
            org_role: member.role,
            source: space.source,
            role: space.role,
          },
          name: space.name,
        },
        value,
      ),
  });

  return (
    <Modal
      onClose={onClose}
      title={memberLabel(member)}
      className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-2xl"
    >
      <div className="flex min-h-0 flex-col gap-6 overflow-y-auto">
        <p className="text-muted-foreground text-sm">
          {member.email}
          {member.joinedAt && (
            <>
              {" · "}
              {t("userDetail.joinedAt", { date: formatDateField(member.joinedAt, "date") })}
            </>
          )}
        </p>

        <SettingRow
          label={t("orgSettings.roleColumn")}
          description={t(`orgSettings.roleHint.${member.role}`)}
          className="pb-0"
        >
          {(labelId) =>
            assignableRoles.length > 0 ? (
              <OrgRoleSelect
                value={member.role}
                roles={assignableRoles}
                onValueChange={onChangeOrgRole}
                disabled={isChangingOrgRole}
                aria-labelledby={labelId}
                className="w-56"
              />
            ) : (
              <span className="text-sm">{t(roleI18nKey(member.role))}</span>
            )
          }
        </SettingRow>

        {showSpaces && (
          <section>
            <h3 className="mb-3 text-base font-semibold">{t("orgSettings.inviteSpacesLabel")}</h3>
            <DataTable
              tiered
              label={t("orgSettings.inviteSpacesLabel")}
              columns={columns}
              rows={member.spaces}
              rowKey={(space) => space.id}
              isLoading={false}
              empty={
                <EmptyState
                  message={t("userDetail.noSpaces")}
                  hint={t("userDetail.noSpacesHint")}
                  icon={AppWindow}
                  compact
                />
              }
            />
          </section>
        )}
      </div>
    </Modal>
  );
}
