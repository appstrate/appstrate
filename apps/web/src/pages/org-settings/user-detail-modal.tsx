// SPDX-License-Identifier: Apache-2.0

/**
 * One person, and everywhere they reach.
 *
 * The table says which spaces; the question it cannot hold in a cell is "as
 * what", and changing that meant opening each space's Members page in turn.
 * Both live here: the org role at the top, then one row per space with its own
 * role control. Two routes, as on the space page — an explicit seat is
 * PATCHed, an implicit member (open space) gets one created.
 */
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AppWindow } from "lucide-react";
import { getErrorMessage } from "@appstrate/core/errors";
import { Button } from "@appstrate/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import type { AssignableOrgRole } from "@appstrate/shared-types";
import type { components } from "../../api/client";
import { DataTable } from "../../components/data-table";
import { Modal } from "../../components/modal";
import { EmptyState } from "../../components/page-states";
import { SettingRow } from "../../components/settings/setting-row";
import { roleI18nKey } from "../../hooks/use-permissions";
import { memberRoleValue, spaceRoleAssignment, useSpaceRoleOptions } from "../../hooks/use-roles";
import { useAddSpaceMember, useUpdateSpaceMember } from "../../hooks/use-space-members";
import type { SpaceMembership } from "../../hooks/use-space-memberships";
import { formatDateField } from "../../lib/format-date";
import { useUserSpaceColumns } from "./user-space-columns";

type OrgMember = components["schemas"]["OrgMember"];

export function UserDetailModal({
  member,
  memberships,
  showSpaces,
  assignableRoles,
  isChangingOrgRole,
  onChangeOrgRole,
  onClose,
}: {
  member: OrgMember;
  memberships: SpaceMembership[];
  /** Only an owner or admin reads every space's member list. */
  showSpaces: boolean;
  assignableRoles: readonly AssignableOrgRole[];
  isChangingOrgRole: boolean;
  onChangeOrgRole: (role: AssignableOrgRole) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const { options: roleOptions, roles } = useSpaceRoleOptions();
  const addMember = useAddSpaceMember();
  const updateMember = useUpdateSpaceMember();
  const isChangingSpaceRole = addMember.isPending || updateMember.isPending;

  const changeSpaceRole = (membership: SpaceMembership, value: string) => {
    const body = spaceRoleAssignment(value);
    const onError = (err: unknown) =>
      toast.error(t("error.prefix", { message: getErrorMessage(err) }));
    const onSuccess = () =>
      toast.success(
        t("spaceMembers.roleUpdated", {
          name: membership.space.name,
          role: roleOptions.find((option) => option.value === value)?.label ?? value,
        }),
      );
    if (membership.member.source === "explicit") {
      updateMember.mutate(
        { params: { path: { id: membership.space.id, userId: member.userId } }, body },
        { onError, onSuccess },
      );
      return;
    }
    addMember.mutate(
      {
        params: { path: { id: membership.space.id } },
        body: { userId: member.userId, ...body },
      },
      { onError, onSuccess },
    );
  };

  const columns = useUserSpaceColumns({
    // Owners and admins reach every space through their org role, so there is
    // no seat to edit; everyone else's is the caller's to change, this caller
    // being an admin everywhere.
    editable: (membership) => membership.member.source !== "org_role" && roleOptions.length > 0,
    roleValue: (membership) =>
      memberRoleValue(membership.member.role, roles) ?? `current:${membership.member.role?.key}`,
    roleOptions,
    isChangingRole: isChangingSpaceRole,
    onChangeRole: changeSpaceRole,
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={member.displayName || member.email || member.userId}
      className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-2xl"
      actions={
        <Button type="button" variant="outline" onClick={onClose}>
          {t("btn.close", { ns: "common" })}
        </Button>
      }
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
          {assignableRoles.length > 0 ? (
            <Select
              value={member.role}
              onValueChange={(value) => onChangeOrgRole(value as AssignableOrgRole)}
              disabled={isChangingOrgRole}
            >
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {assignableRoles.map((role) => (
                  <SelectItem key={role} value={role}>
                    {t(roleI18nKey(role))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="text-sm">{t(roleI18nKey(member.role))}</span>
          )}
        </SettingRow>

        {showSpaces && (
          <section>
            <h3 className="mb-3 text-base font-semibold">{t("userDetail.spacesSection")}</h3>
            <DataTable
              label={t("userDetail.spacesSection")}
              columns={columns}
              rows={memberships}
              rowKey={(membership) => membership.space.id}
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
