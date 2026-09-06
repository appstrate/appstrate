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
import { useAuth } from "../../hooks/use-auth";
import { usePermissions, roleI18nKey } from "../../hooks/use-permissions";
import { OrgInvitationForm } from "../../components/org-invitation-form";
import { Modal } from "../../components/modal";
import { ConfirmModal } from "../../components/confirm-modal";
import { OrgInvitationsList } from "../../components/org-invitations-list";
import { LoadingState, ErrorState, EmptyState } from "../../components/page-states";
import { toast } from "sonner";
import {
  assignableRolesForMember,
  canRemoveMember,
  type AssignableOrgRole,
} from "@appstrate/shared-types";

type OrgMember = components["schemas"]["OrgMember"];
export function OrgSettingsMembersPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { currentOrg } = useOrg();
  const { user } = useAuth();
  const { can, orgRole } = usePermissions();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;

  const canInvite = can("members:invite");
  const canChangeRole = can("members:change-role");

  const [invitingOrgId, setInvitingOrgId] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<{ label: string; id: string } | null>(null);

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
  const invalidateOrg = () => {
    void queryClient.invalidateQueries({ queryKey: ["get", "/api/orgs/{orgId}"] });
  };

  const removeMemberMutation = $api.useMutation("delete", "/api/orgs/{orgId}/members/{userId}", {
    onSuccess: invalidateOrg,
    onError: (err) => toast.error(t("error.prefix", { message: getErrorMessage(err) })),
  });

  const changeRoleMutation = $api.useMutation("put", "/api/orgs/{orgId}/members/{userId}", {
    onSuccess: invalidateOrg,
    onError: (err) => toast.error(t("error.prefix", { message: getErrorMessage(err) })),
  });

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={getErrorMessage(error)} />;

  const handleRemove = (member: OrgMember) => {
    const label = member.displayName || member.email || member.userId;
    setConfirmState({ label, id: member.userId });
  };

  const handleRoleChange = (userId: string, newRole: AssignableOrgRole) => {
    if (!orgId) return;
    changeRoleMutation.mutate({
      params: { path: { orgId, userId } },
      body: { role: newRole },
    });
  };

  return (
    <>
      <p className="text-muted-foreground mb-4 text-sm">{t("orgSettings.usersDescription")}</p>
      {canInvite && orgId && (
        <div className="mb-4 flex justify-end">
          <Button data-testid="invite-org-user-button" onClick={() => setInvitingOrgId(orgId)}>
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
                      onValueChange={(v) => handleRoleChange(member.userId, v as AssignableOrgRole)}
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

      {canInvite && orgId && invitingOrgId === orgId && (
        <Modal
          open
          onClose={() => setInvitingOrgId(null)}
          title={t("orgSettings.inviteUser")}
          className="max-h-[85dvh] overflow-y-auto sm:max-w-xl"
        >
          <OrgInvitationForm
            key={orgId}
            orgId={orgId}
            allowGuest
            onSuccess={() => setInvitingOrgId(null)}
            onCancel={() => setInvitingOrgId(null)}
          />
        </Modal>
      )}

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
