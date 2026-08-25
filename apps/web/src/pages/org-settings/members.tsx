// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useForm, useWatch } from "react-hook-form";
import { Plus, Users } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { Badge } from "@appstrate/ui/components/badge";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
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
import { ConfirmModal } from "../../components/confirm-modal";
import { Modal } from "../../components/modal";
import { CopyLinkButton } from "../../components/copy-link-button";
import { ErrorState, EmptyState } from "../../components/page-states";
import { DataTable } from "../../components/data-table";
import { SettingsPageActions } from "../../components/settings/settings-page-actions";
import { PageActionsMenu } from "../../components/page-actions-menu";
import { useMemberColumns } from "./member-columns";
import { Spinner } from "../../components/spinner";
import { toast } from "sonner";
import {
  ASSIGNABLE_ORG_ROLES,
  assignableRolesForMember,
  canRemoveMember,
  type AssignableOrgRole,
} from "@appstrate/shared-types";

type OrgMember = components["schemas"]["OrgMember"];

export function OrgSettingsMembersPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { currentOrg } = useOrg();
  const { user } = useAuth();
  const { role, isAdmin } = usePermissions();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;

  const [inviteOpen, setInviteOpen] = useState(false);
  const [confirmState, setConfirmState] = useState<{ label: string; id: string } | null>(null);

  const inviteForm = useForm<{ email: string; role: AssignableOrgRole }>({
    defaultValues: { email: "", role: "member" },
  });
  const inviteRole = useWatch({ control: inviteForm.control, name: "role" });

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

  // Polymorphic bare resource: the created member (has `userId`) or the
  // created invitation (has `id` + `token`).
  const addMemberMutation = $api.useMutation("post", "/api/orgs/{orgId}/members", {
    onSuccess: () => {
      invalidateOrg();
      inviteForm.reset();
      setInviteOpen(false);
    },
    onError: (err) => {
      inviteForm.setError("root", { message: getErrorMessage(err) });
    },
  });

  const cancelInvitationMutation = $api.useMutation(
    "delete",
    "/api/orgs/{orgId}/invitations/{invitationId}",
    {
      onSuccess: invalidateOrg,
      onError: (err) => toast.error(t("error.prefix", { message: getErrorMessage(err) })),
    },
  );

  const changeInvitationRoleMutation = $api.useMutation(
    "put",
    "/api/orgs/{orgId}/invitations/{invitationId}",
    {
      onSuccess: invalidateOrg,
      onError: (err) => toast.error(t("error.prefix", { message: getErrorMessage(err) })),
    },
  );

  const removeMemberMutation = $api.useMutation("delete", "/api/orgs/{orgId}/members/{userId}", {
    onSuccess: invalidateOrg,
    onError: (err) => toast.error(t("error.prefix", { message: getErrorMessage(err) })),
  });

  const changeRoleMutation = $api.useMutation("put", "/api/orgs/{orgId}/members/{userId}", {
    onSuccess: invalidateOrg,
    onError: (err) => toast.error(t("error.prefix", { message: getErrorMessage(err) })),
  });

  const handleInvite = (data: { email: string; role: AssignableOrgRole }) => {
    const trimmed = data.email.trim();
    if (!trimmed || !orgId) return;
    addMemberMutation.mutate({
      params: { path: { orgId } },
      body: { email: trimmed, role: data.role },
    });
  };

  const handleInviteClose = () => {
    inviteForm.reset();
    addMemberMutation.reset();
    setInviteOpen(false);
  };

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

  const memberColumns = useMemberColumns({
    assignableRoles: (member) =>
      role
        ? assignableRolesForMember({
            actorRole: role,
            targetRole: member.role,
            isSelf: member.userId === user?.id,
          })
        : [],
    canRemove: (member) =>
      role
        ? canRemoveMember({
            actorRole: role,
            targetRole: member.role,
            isSelf: member.userId === user?.id,
          })
        : false,
    isChangingRole: changeRoleMutation.isPending,
    isRemoving: removeMemberMutation.isPending,
    onChangeRole: handleRoleChange,
    onRemove: handleRemove,
  });

  return (
    <>
      {isAdmin && (
        <SettingsPageActions>
          <PageActionsMenu>
            <DropdownMenuItem data-page-action="invite" onSelect={() => setInviteOpen(true)}>
              <Plus />
              {t("orgSettings.inviteMember")}
            </DropdownMenuItem>
          </PageActionsMenu>
        </SettingsPageActions>
      )}

      {isAdmin && (
        <Modal
          open={inviteOpen}
          onClose={handleInviteClose}
          title={t("orgSettings.inviteMember")}
          actions={
            <>
              <Button type="button" variant="outline" onClick={handleInviteClose}>
                {t("btn.cancel", { ns: "common" })}
              </Button>
              <Button
                type="submit"
                form="invite-member-form"
                disabled={addMemberMutation.isPending}
              >
                {addMemberMutation.isPending ? <Spinner /> : t("orgSettings.invite")}
              </Button>
            </>
          }
        >
          <form
            id="invite-member-form"
            onSubmit={inviteForm.handleSubmit(handleInvite)}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="invite-member-email">{t("invite.emailLabel")}</Label>
              <Input
                id="invite-member-email"
                type="email"
                {...inviteForm.register("email", { required: true })}
                placeholder="email@example.com"
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-member-role">{t("invite.roleLabel")}</Label>
              <Select
                value={inviteRole}
                onValueChange={(v) => inviteForm.setValue("role", v as AssignableOrgRole)}
              >
                <SelectTrigger id="invite-member-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ASSIGNABLE_ORG_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {t(roleI18nKey(r))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {inviteForm.formState.errors.root && (
              <p className="text-destructive text-sm">{inviteForm.formState.errors.root.message}</p>
            )}
          </form>
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
        isLoading={isLoading}
        isError={Boolean(error)}
        error={<ErrorState message={getErrorMessage(error)} compact />}
      />

      {invitations.length > 0 && (
        <>
          <div className="text-muted-foreground mt-6 mb-4 text-sm font-medium">
            {t("orgSettings.pendingInvitations")}
          </div>
          <div className="flex flex-col gap-3">
            {invitations.map((inv) => (
              <div key={inv.id} className="border-border bg-card rounded-lg border p-5">
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <h3 className="text-sm font-semibold">{inv.email}</h3>
                    <span className="text-muted-foreground text-sm">
                      {t(roleI18nKey(inv.role))}
                    </span>
                  </div>
                  <Badge variant="pending">{t("orgSettings.invited")}</Badge>
                </div>
                <div className="border-border mt-3 flex gap-2 border-t pt-3">
                  {isAdmin && (
                    <Select
                      value={inv.role}
                      onValueChange={(v) =>
                        changeInvitationRoleMutation.mutate({
                          params: { path: { orgId: orgId ?? "", invitationId: inv.id } },
                          body: { role: v as AssignableOrgRole },
                        })
                      }
                      disabled={changeInvitationRoleMutation.isPending}
                    >
                      <SelectTrigger className="w-[140px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ASSIGNABLE_ORG_ROLES.map((r) => (
                          <SelectItem key={r} value={r}>
                            {t(roleI18nKey(r))}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <CopyLinkButton token={inv.token} />
                  {isAdmin && (
                    <Button
                      variant="destructive"
                      size="sm"
                      className="ml-auto"
                      onClick={() =>
                        cancelInvitationMutation.mutate({
                          params: { path: { orgId: orgId ?? "", invitationId: inv.id } },
                        })
                      }
                      disabled={cancelInvitationMutation.isPending}
                    >
                      {t("btn.cancel")}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {members.length === 0 && invitations.length === 0 && (
        <EmptyState
          message={t("orgSettings.noMembers")}
          hint={t("orgSettings.noMembersHint")}
          icon={Users}
          compact
        />
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
