// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { UserPlus, Users } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Badge } from "@appstrate/ui/components/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { useQueryClient } from "@tanstack/react-query";
import { getErrorMessage } from "@appstrate/core/errors";
import { $api, type components } from "../../api/client";
import { useOrg } from "../../hooks/use-org";
import { invalidateIntegrationQueries } from "../../hooks/use-integrations";
import { useAuth } from "../../hooks/use-auth";
import { usePermissions, roleI18nKey } from "../../hooks/use-permissions";
import { OrgInvitationForm } from "../../components/org-invitation-form";
import { Modal } from "../../components/modal";
import { ConfirmModal } from "../../components/confirm-modal";
import { OrgInvitationsList } from "../../components/org-invitations-list";
import { LoadingState, ErrorState, EmptyState } from "../../components/page-states";
import { toast } from "sonner";
import { assignableRolesForMember, canRemoveMember, type OrgRole } from "@appstrate/shared-types";
import { errorMessage } from "../../lib/mutation-error";

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

  const canInvite = can("members:invite");
  const canChangeRole = can("members:change-role");

  const [inviting, setInviting] = useState(false);
  const [confirmState, setConfirmState] = useState<{ label: string; id: string } | null>(null);
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

  const toastMemberError = (err: unknown) =>
    toast.error(t("error.prefix", { message: getErrorMessage(err) }));

  const removeMemberMutation = $api.useMutation("delete", "/api/orgs/{orgId}/members/{userId}", {
    onSuccess: invalidateOrg,
    onError: toastMemberError,
  });

  const changeRoleMutation = $api.useMutation("put", "/api/orgs/{orgId}/members/{userId}", {
    onSuccess: invalidateOrg,
    onError: toastMemberError,
  });

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={errorMessage(error)} />;

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

  return (
    <>
      <p className="text-muted-foreground mb-4 text-sm">{t("orgSettings.usersDescription")}</p>
      {canInvite && orgId && (
        <div className="mb-4 flex justify-end">
          <Button data-testid="invite-org-user-button" onClick={() => setInviting(true)}>
            <UserPlus />
            {t("orgSettings.inviteUser")}
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {members.map((member) => {
          const label = member.displayName || member.email || member.userId;
          const isMemberOwner = member.role === "owner";
          const isSelf = member.userId === user?.id;
          const assignableRoles =
            orgRole && canChangeRole
              ? assignableRolesForMember({ actorRole: orgRole, targetRole: member.role, isSelf })
              : [];
          const canRemove =
            orgRole && can("members:remove")
              ? canRemoveMember({ actorRole: orgRole, targetRole: member.role, isSelf })
              : false;
          return (
            <div
              key={member.userId}
              className="border-border bg-card flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold break-words">{label}</h3>
                  {member.email && member.email !== label && (
                    <span className="text-muted-foreground text-sm">{member.email}</span>
                  )}
                </div>
                {assignableRoles.length === 0 && (
                  <Badge
                    variant={
                      isMemberOwner ? "running" : member.role === "admin" ? "success" : "pending"
                    }
                  >
                    {t(roleI18nKey(member.role))}
                  </Badge>
                )}
              </div>
              {(assignableRoles.length > 0 || canRemove) && (
                <div className="flex flex-wrap items-center gap-2">
                  {assignableRoles.length > 0 && (
                    <Select
                      value={member.role}
                      onValueChange={(v) => handleRoleChange(member, v as OrgRole)}
                      disabled={changeRoleMutation.isPending}
                    >
                      <SelectTrigger
                        className="w-full sm:w-[200px]"
                        aria-label={t("orgSettings.inviteRoleAriaLabel")}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {assignableRoles.map((r) => (
                          <SelectItem key={r} value={r}>
                            {t(roleI18nKey(r))}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {canRemove && (
                    <Button
                      variant="destructive"
                      size="sm"
                      className="ml-auto"
                      onClick={() => handleRemove(member)}
                      disabled={removeMemberMutation.isPending}
                    >
                      {t("btn.remove")}
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {orgId && <OrgInvitationsList key={orgId} orgId={orgId} invitations={invitations} />}

      {members.length === 0 && invitations.length === 0 && (
        <EmptyState
          message={t("orgSettings.noMembers")}
          hint={t("orgSettings.noMembersHint")}
          icon={Users}
          compact
        />
      )}

      {canInvite && orgId && inviting && (
        <Modal
          open
          onClose={() => setInviting(false)}
          title={t("orgSettings.inviteUser")}
          className="max-h-[85dvh] overflow-y-auto sm:max-w-xl"
        >
          <OrgInvitationForm
            key={orgId}
            orgId={orgId}
            allowGuest
            onSuccess={() => setInviting(false)}
            onCancel={() => setInviting(false)}
          />
        </Modal>
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
