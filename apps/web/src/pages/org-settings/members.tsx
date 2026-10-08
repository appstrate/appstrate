// SPDX-License-Identifier: Apache-2.0

import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plus, Users } from "lucide-react";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { useQueryClient } from "@tanstack/react-query";
import { $api, type components } from "../../api/client";
import { useOrg } from "../../hooks/use-org";
import { invalidateIntegrationQueries } from "../../hooks/use-integrations";
import { useAuth } from "../../hooks/use-auth";
import { roleI18nKey, usePermissions } from "../../hooks/use-permissions";
import { useSpaceMembershipsByUser } from "../../hooks/use-space-memberships";
import { useModalParam } from "../../hooks/use-modal-param";
import { Modal } from "../../components/modal";
import { ConfirmModal } from "../../components/confirm-modal";
import { ErrorState, EmptyState } from "../../components/page-states";
import { DataTable } from "../../components/data-table";
import { SettingsPageActions } from "../../components/settings/settings-page-actions";
import { PageActionsMenu } from "../../components/page-actions-menu";
import { InvitationsTable } from "../../components/invitations-table";
import { OrgInvitationForm } from "../../components/org-invitation-form";
import { useMemberColumns } from "./member-columns";
import { UserDetailModal } from "./user-detail-modal";
import { useState } from "react";
import { hasFullOrgAccess } from "../../lib/org-role";
import { assignableRolesForMember, canRemoveMember, type OrgRole } from "@appstrate/shared-types";

type OrgMember = components["schemas"]["OrgMember"];

/**
 * Implicit space reach per role: a drop ends access, and the server then unshares connections.
 * Exhaustive, so a new role must be placed here rather than read as one that revokes access.
 */
const ROLE_REACH = { owner: 2, admin: 2, member: 1, guest: 0 } satisfies Record<OrgRole, number>;

export function OrgSettingsMembersPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { currentOrg } = useOrg();
  const { user } = useAuth();
  const { can, orgRole } = usePermissions();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;
  const invite = useModalParam("invite");
  const userParam = useModalParam("user");
  const location = useLocation();

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

  const {
    data: orgData,
    isLoading,
    error,
  } = $api.useQuery(
    "get",
    "/api/orgs/{orgId}",
    { params: { path: { orgId: orgId ?? "" } } },
    { enabled: !!orgId },
  );

  const members = orgData?.members ?? [];
  const invitations = orgData?.invitations ?? [];
  // A removal or a role drop that ends space access unshares the member's connections.
  const invalidateOrg = () => {
    void queryClient.invalidateQueries({ queryKey: ["get", "/api/orgs/{orgId}"] });
    void invalidateIntegrationQueries(queryClient);
  };

  const removeMemberMutation = $api.useMutation("delete", "/api/orgs/{orgId}/members/{userId}", {
    onSuccess: invalidateOrg,
  });

  const changeRoleMutation = $api.useMutation("put", "/api/orgs/{orgId}/members/{userId}", {
    onSuccess: invalidateOrg,
  });

  const handleRemove = (member: OrgMember) => {
    const label = member.displayName || member.email || member.userId;
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
        label: member.displayName || member.email || member.userId,
        id: member.userId,
        role: newRole,
        from: member.role,
      });
      return;
    }
    changeRole(member.userId, newRole);
  };

  // Which spaces a person reaches, and as what: one shared query set for the
  // column and for the detail, so opening a person costs nothing more.
  const seesEverySpace = hasFullOrgAccess(orgRole);
  const { byUser: spacesByUser } = useSpaceMembershipsByUser(seesEverySpace);

  const memberColumns = useMemberColumns({
    assignableRoles: (member) =>
      orgRole && canChangeRole
        ? assignableRolesForMember({
            actorRole: orgRole,
            targetRole: member.role,
            isSelf: member.userId === user?.id,
          })
        : [],
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
    spaces: seesEverySpace
      ? (member) => (spacesByUser.get(member.userId) ?? []).map(({ space }) => space.name)
      : undefined,
  });

  const openedUser = members.find((member) => member.userId === userParam.value);

  return (
    <>
      {canInvite && (
        <SettingsPageActions>
          <PageActionsMenu>
            <DropdownMenuItem data-page-action="invite" onSelect={() => invite.open()}>
              <Plus />
              {t("orgSettings.inviteMember")}
            </DropdownMenuItem>
          </PageActionsMenu>
        </SettingsPageActions>
      )}

      {/* The invitation is one form wherever it is made: the org role, then the
          spaces it opens and the role in each — which is what a guest needs,
          having no implicit access anywhere. */}
      {canInvite && orgId && (
        <Modal
          open={invite.value !== null}
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
        label={t("orgSettings.tabMembers")}
        columns={memberColumns}
        rows={members}
        rowKey={(member) => member.userId}
        rowHref={(member) => `?user=${encodeURIComponent(member.userId)}`}
        rowState={() => location.state}
        rowLabel={(member) => member.displayName || member.email || member.userId}
        isLoading={isLoading}
        isError={Boolean(error)}
        error={<ErrorState error={error} compact />}
      />

      {openedUser && (
        <UserDetailModal
          key={openedUser.userId}
          member={openedUser}
          memberships={spacesByUser.get(openedUser.userId) ?? []}
          showSpaces={seesEverySpace}
          assignableRoles={
            orgRole && canChangeRole
              ? assignableRolesForMember({
                  actorRole: orgRole,
                  targetRole: openedUser.role,
                  isSelf: openedUser.userId === user?.id,
                })
              : []
          }
          isChangingOrgRole={changeRoleMutation.isPending}
          onChangeOrgRole={(role) => handleRoleChange(openedUser, role)}
          onClose={userParam.close}
        />
      )}

      {orgId && <InvitationsTable orgId={orgId} invitations={invitations} />}

      {members.length === 0 && invitations.length === 0 && (
        <EmptyState
          message={t("orgSettings.noMembers")}
          hint={t("orgSettings.noMembersHint")}
          icon={Users}
          compact
        />
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
        title={t("btn.confirm", { ns: "common" })}
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

function revokesAccess(from: OrgRole, to: OrgRole): boolean {
  return ROLE_REACH[to] < ROLE_REACH[from];
}
