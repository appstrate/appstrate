// SPDX-License-Identifier: Apache-2.0

import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plus, Users } from "lucide-react";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { useQueryClient } from "@tanstack/react-query";
import { getErrorMessage } from "@appstrate/core/errors";
import { toast } from "sonner";
import { $api, type components } from "../../api/client";
import { useOrg } from "../../hooks/use-org";
import { useAuth } from "../../hooks/use-auth";
import { usePermissions } from "../../hooks/use-permissions";
import { useModalParam } from "../../hooks/use-modal-param";
import { Modal } from "../../components/modal";
import { ConfirmModal } from "../../components/confirm-modal";
import { LoadingState, ErrorState, EmptyState } from "../../components/page-states";
import { DataTable } from "../../components/data-table";
import { SettingsPageActions } from "../../components/settings/settings-page-actions";
import { PageActionsMenu } from "../../components/page-actions-menu";
import { InvitationsTable } from "../../components/invitations-table";
import { OrgInvitationForm } from "../../components/org-invitation-form";
import { useMemberColumns } from "./member-columns";
import { useState } from "react";
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
  const invite = useModalParam("invite");
  const location = useLocation();

  const [confirmState, setConfirmState] = useState<{ label: string; id: string } | null>(null);
  const canInvite = can("members:invite");
  const canChangeRole = can("members:change-role");

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
  });

  // Below the hooks: an early return above `useMemberColumns` would change
  // the hook order between a loading render and a loaded one.
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={getErrorMessage(error)} />;

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

      {/* The one question this page raises and cannot answer from a row:
          what does a role let someone do? The answer is a guide with its own
          place — the roles page, on the org roles, as a matrix — reached from
          the sentence that raises it rather than from a second button beside
          the title's single Actions trigger. */}
      <p className="text-muted-foreground mb-6 max-w-2xl text-sm leading-relaxed">
        {t("orgSettings.rolesIntro")}{" "}
        <Link
          to="/org-settings/roles?view=matrix"
          state={location.state}
          className="text-primary underline underline-offset-4"
        >
          {t("orgRolesGuide.link")}
        </Link>
      </p>

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
