// SPDX-License-Identifier: Apache-2.0

/**
 * Pending invitations, as a settings table.
 *
 * The organisation's Users page and a space's Members page show the SAME
 * object — one org invitation that may carry space roles — so they share this
 * table rather than each drawing its own. A space page lists only the
 * invitations that assign that space. Tokens are organisation invitation
 * authority, so the table shows to `members:invite` holders only, wherever it
 * is mounted.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getErrorMessage } from "@appstrate/core/errors";
import { $api, type components } from "../api/client";
import { useOrg } from "../hooks/use-org";
import { usePermissions } from "../hooks/use-permissions";
import { useSpaces } from "../hooks/use-spaces";
import { spaceRoleValue, useSpaceRoleOptions } from "../hooks/use-roles";
import { useCopyToClipboard } from "../hooks/use-copy-to-clipboard";
import { useModalParam } from "../hooks/use-modal-param";
import { ConfirmModal } from "./confirm-modal";
import { DataTable } from "./data-table";
import { Modal } from "./modal";
import { OrgInvitationForm } from "./org-invitation-form";
import { SettingsGroup } from "./settings/setting-row";
import { useInvitationColumns } from "./invitation-columns";

type Invitation = components["schemas"]["OrgInvitationInfo"];

export function InvitationsTable({
  orgId,
  invitations,
  spaceId,
}: {
  orgId: string;
  invitations: Invitation[];
  spaceId?: string;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();
  const { currentOrg } = useOrg();
  const { can } = usePermissions();
  const { data: spaces } = useSpaces();
  const { options: roles } = useSpaceRoleOptions();
  const { copy } = useCopyToClipboard();
  const editParam = useModalParam("invitation");
  const [cancelingId, setCancelingId] = useState<string | null>(null);

  const canInvite = currentOrg?.id === orgId && can("members:invite");
  const canEdit = currentOrg?.id === orgId && can("members:change-role");
  const visible = spaceId
    ? invitations.filter((invitation) =>
        invitation.space_assignments.some((assignment) => assignment.space_id === spaceId),
      )
    : invitations;
  const editing = visible.find((invitation) => invitation.id === editParam.value);
  const canceling = visible.find((invitation) => invitation.id === cancelingId);
  const spaceName = (id: string) =>
    spaces?.find((space) => space.id === id)?.name ?? t("orgSettings.assignmentUnavailableSpace");

  const cancel = $api.useMutation("delete", "/api/orgs/{orgId}/invitations/{invitationId}", {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["get", "/api/orgs/{orgId}"] });
      setCancelingId(null);
      toast.success(t("orgSettings.invitationCanceled"));
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const columns = useInvitationColumns({
    assignments: (invitation) =>
      invitation.space_assignments.map(
        (assignment) =>
          `${spaceName(assignment.space_id)} · ${
            roles.find((role) => role.value === spaceRoleValue(assignment))?.label ??
            t("orgSettings.assignmentUnavailableRole")
          }`,
      ),
    canEdit,
    isCanceling: cancel.isPending,
    onEdit: (invitation) => editParam.open(invitation.id),
    // Resolved on click: the origin is a browser fact, and nothing on screen
    // shows the clipboard changed, hence the toast.
    onCopyLink: (invitation) => {
      void copy(`${window.location.origin}/invite/${invitation.token}`);
      toast.success(t("orgSettings.invitationLinkCopied"));
    },
    onCancel: (invitation) => setCancelingId(invitation.id),
  });

  if (!canInvite || visible.length === 0) return null;

  return (
    <SettingsGroup title={t("orgSettings.pendingInvitations")} className="mt-8">
      <DataTable
        label={t("orgSettings.pendingInvitations")}
        columns={columns}
        rows={visible}
        rowKey={(invitation) => invitation.id}
        isLoading={false}
      />
      <Modal
        open={!!editing}
        onClose={editParam.close}
        title={t("orgSettings.editInvitation")}
        className="max-h-[85dvh] overflow-y-auto sm:max-w-xl"
      >
        {editing && (
          <OrgInvitationForm
            key={`${orgId}:${editing.id}`}
            orgId={orgId}
            invitation={editing}
            onSuccess={editParam.close}
            onCancel={editParam.close}
          />
        )}
      </Modal>
      <ConfirmModal
        open={!!canceling}
        onClose={() => {
          if (!cancel.isPending) setCancelingId(null);
        }}
        title={t("orgSettings.cancelInvitation")}
        confirmLabel={t("orgSettings.cancelInvitation")}
        isPending={cancel.isPending}
        description={
          canceling
            ? t(
                canceling.space_assignments.length
                  ? "orgSettings.cancelInvitationSpacesConfirm"
                  : "orgSettings.cancelInvitationConfirm",
                {
                  email: canceling.email,
                  spaces: canceling.space_assignments
                    .map((assignment) => spaceName(assignment.space_id))
                    .join(", "),
                },
              )
            : ""
        }
        onConfirm={() => {
          if (canceling) cancel.mutate({ params: { path: { orgId, invitationId: canceling.id } } });
        }}
      />
    </SettingsGroup>
  );
}
