// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Plus, Users } from "lucide-react";
import type { components } from "../../api/client";
import { useChangeMemberRole, useOrg, useOrgDetail, useRemoveMember } from "../../hooks/use-org";
import { useAuth } from "../../hooks/use-auth";
import { roleI18nKey, usePermissions } from "../../hooks/use-permissions";
import { useModalParam, useModalTarget } from "../../hooks/use-modal-param";
import { Modal } from "../../components/modal";
import { ConfirmModal } from "../../components/confirm-modal";
import { EmptyState, EmptyStateAction } from "../../components/page-states";
import { DataTable } from "../../components/data-table";
import { SettingsPageActions } from "../../components/settings/settings-page-actions";
import type { MenuAction } from "../../lib/menu-action";
import { InvitationsTable } from "../../components/invitations-table";
import { OrgInvitationForm } from "../../components/org-invitation-form";
import { useMemberColumns } from "./member-columns";
import { UserDetailModal } from "./user-detail-modal";
import { useState } from "react";
import { hasFullOrgAccess } from "../../lib/org-role";
import { memberLabel } from "../../lib/members";
import { assignableRolesForMember, canRemoveMember, type OrgRole } from "@appstrate/shared-types";

type OrgMember = components["schemas"]["OrgMember"];

export function OrgSettingsMembersPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { currentOrg } = useOrg();
  const { user } = useAuth();
  const { can, orgRole } = usePermissions();
  const orgId = currentOrg?.id;
  const invite = useModalParam("invite");

  const [confirmState, setConfirmState] = useState<{ label: string; id: string } | null>(null);
  const canInvite = can("members:invite");
  const canChangeRole = can("members:change-role");

  // Ownership changes confirm first (a new owner can remove whoever named them), and so do
  // demotions that end space access.
  const [roleChange, setRoleChange] = useState<{
    label: string;
    id: string;
    role: OrgRole;
    from: OrgRole;
  } | null>(null);

  const { data: orgData, isLoading, error } = useOrgDetail();

  const members = orgData?.members ?? [];
  const memberParam = useModalTarget("member", orgData?.members, (member) => member.userId);
  const invitations = orgData?.invitations ?? [];

  const removeMemberMutation = useRemoveMember();
  const changeRoleMutation = useChangeMemberRole();

  const handleRemove = (member: OrgMember) => {
    const label = memberLabel(member);
    setConfirmState({ label, id: member.userId });
  };

  const changeRole = (userId: string, role: OrgRole, onSuccess?: () => void) => {
    if (!orgId) return;
    changeRoleMutation.mutate(
      { params: { path: { orgId, userId } }, body: { role } },
      { onSuccess },
    );
  };

  const handleRoleChange = (member: OrgMember, newRole: OrgRole) => {
    if (newRole === "owner" || member.role === "owner" || revokesAccess(member.role, newRole)) {
      setRoleChange({
        label: memberLabel(member),
        id: member.userId,
        role: newRole,
        from: member.role,
      });
      return;
    }
    changeRole(member.userId, newRole);
  };

  // Which spaces a person reaches, and as what, comes with the member itself:
  // the column and the detail read the same rows.
  const seesEverySpace = hasFullOrgAccess(orgRole);

  const assignableRoles = (member: OrgMember) =>
    orgRole && canChangeRole
      ? assignableRolesForMember({
          actorRole: orgRole,
          targetRole: member.role,
          isSelf: member.userId === user?.id,
        })
      : [];

  const memberColumns = useMemberColumns({
    assignableRoles,
    canRemove: (member) =>
      orgRole && can("members:remove")
        ? canRemoveMember({
            actorRole: orgRole,
            targetRole: member.role,
            isSelf: member.userId === user?.id,
          })
        : false,
    isChangingRole: changeRoleMutation.isPending,
    isRemoving: removeMemberMutation.isPending,
    onChangeRole: handleRoleChange,
    onRemove: handleRemove,
    spaces: seesEverySpace ? (member) => member.spaces.map((space) => space.name) : undefined,
  });

  const openedUser = memberParam.target;
  const inviteAction: MenuAction = {
    id: "invite",
    icon: Plus,
    label: t("orgSettings.inviteMember"),
    onSelect: () => invite.open(),
    hidden: !canInvite,
  };

  return (
    <>
      <SettingsPageActions actions={[inviteAction]} />

      {/* The invitation is one form wherever it is made: the org role, then the
          spaces it opens and the role in each — which is what a guest needs,
          having no implicit access anywhere. */}
      {canInvite && orgId && invite.value !== null && (
        <Modal
          onClose={invite.close}
          title={t("orgSettings.inviteMember")}
          className="max-h-[85dvh] overflow-y-auto sm:max-w-xl"
        >
          <OrgInvitationForm
            key={`${orgId}:${invite.value}`}
            orgId={orgId}
            allowGuest
            onSuccess={invite.close}
            onCancel={invite.close}
          />
        </Modal>
      )}

      {/* No `empty` prop on purpose: this page has TWO lists and one shared
          empty state below, for when neither members nor invitations exist. A
          per-list empty sentence here would fire while invitations are pending
          and say the page is empty when it is not. */}
      <DataTable
        tableId="members"
        label={t("orgSettings.tabMembers")}
        columns={memberColumns}
        rows={members}
        rowKey={(member) => member.userId}
        rowAction={(member) => memberParam.open(member.userId)}
        rowLabel={memberLabel}
        isLoading={isLoading}
        failure={error}
      />

      {openedUser && (
        <UserDetailModal
          key={openedUser.userId}
          member={openedUser}
          showSpaces={seesEverySpace}
          assignableRoles={assignableRoles(openedUser)}
          isChangingOrgRole={changeRoleMutation.isPending}
          onChangeOrgRole={(role) => handleRoleChange(openedUser, role)}
          onClose={memberParam.close}
        />
      )}

      {orgId && <InvitationsTable orgId={orgId} invitations={invitations} />}

      {!isLoading && !error && members.length === 0 && invitations.length === 0 && (
        <EmptyState
          message={t("orgSettings.noMembers")}
          hint={t("orgSettings.noMembersHint")}
          icon={Users}
          compact
        >
          <EmptyStateAction action={inviteAction} />
        </EmptyState>
      )}

      <ConfirmModal
        open={!!roleChange}
        onClose={() => setRoleChange(null)}
        title={t(
          roleChange?.role === "owner"
            ? "orgSettings.promoteOwnerTitle"
            : roleChange?.from === "owner"
              ? "orgSettings.demoteOwnerTitle"
              : "orgSettings.demoteTitle",
        )}
        description={
          !roleChange
            ? ""
            : roleChange.role === "owner"
              ? t("orgSettings.promoteOwnerConfirm", { name: roleChange.label })
              : [
                  t(
                    roleChange.from === "owner"
                      ? "orgSettings.demoteOwnerConfirm"
                      : "orgSettings.demoteConfirm",
                    { name: roleChange.label, role: t(roleI18nKey(roleChange.role)) },
                  ),
                  revokesAccess(roleChange.from, roleChange.role)
                    ? t("orgSettings.demotionUnsharesConnections")
                    : "",
                  // A promotion deleted the explicit space roles (RBAC spec §3.2).
                  hasFullOrgAccess(roleChange.from) && !hasFullOrgAccess(roleChange.role)
                    ? t("orgSettings.demotionRestoresNoSpaceRole")
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")
        }
        confirmLabel={t(
          roleChange?.role === "owner"
            ? "orgSettings.promoteOwner"
            : roleChange?.from === "owner"
              ? "orgSettings.demoteOwner"
              : "orgSettings.demote",
        )}
        isPending={changeRoleMutation.isPending}
        onConfirm={() => {
          if (roleChange) {
            changeRole(roleChange.id, roleChange.role, () => setRoleChange(null));
          }
        }}
      />

      <ConfirmModal
        open={!!confirmState}
        onClose={() => setConfirmState(null)}
        title={t("orgSettings.removeMemberTitle")}
        confirmLabel={t("btn.remove", { ns: "common" })}
        description={
          confirmState ? t("orgSettings.removeMember", { name: confirmState.label }) : ""
        }
        isPending={removeMemberMutation.isPending}
        onConfirm={() => {
          if (confirmState) {
            removeMemberMutation.mutate(
              { params: { path: { orgId: orgId ?? "", userId: confirmState.id } } },
              { onSuccess: () => setConfirmState(null) },
            );
          }
        }}
      />
    </>
  );
}

/** How far each role reaches into spaces on its own; owner and admin reach every one. */
const ROLE_REACH = {
  owner: 2,
  admin: 2,
  member: 1,
  guest: 0,
} satisfies Record<OrgRole, number>;

/** A drop ends implicit space access, and the server then unshares connections. */
function revokesAccess(from: OrgRole, to: OrgRole): boolean {
  return ROLE_REACH[to] < ROLE_REACH[from];
}
