// SPDX-License-Identifier: Apache-2.0

/**
 * Pending invitations, as a settings table.
 *
 * The organization's Users page and a space's Members page show the SAME
 * object — one org invitation that may carry space roles — so they share this
 * table rather than each drawing its own. A space page lists only the
 * invitations that assign that space. Tokens are organization invitation
 * authority, so the table shows to `members:invite` holders only, wherever it
 * is mounted.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { components } from "../api/client";
import { useCancelInvitation, useOrg } from "../hooks/use-org";
import { usePermissions } from "../hooks/use-permissions";
import { useSpaceLabelOf, useSpaces } from "../hooks/use-spaces";
import { invitationUrl } from "../lib/invitation-url";
import { spaceRoleValue, useSpaceRoleOptions } from "../hooks/use-roles";
import { useCopyToClipboard } from "@appstrate/ui/use-copy-to-clipboard";
import { useModalTarget } from "../hooks/use-modal-param";
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
  const { currentOrg } = useOrg();
  const { can } = usePermissions();
  const { isLoading: spacesLoading } = useSpaces();
  const spaceLabelOf = useSpaceLabelOf();
  const { options: roles, isLoading: rolesLoading } = useSpaceRoleOptions();
  const { copy } = useCopyToClipboard();
  const [cancelingId, setCancelingId] = useState<string | null>(null);

  const canInvite = currentOrg?.id === orgId && can("members:invite");
  const canEdit = currentOrg?.id === orgId && can("members:change-role");
  const visible = spaceId
    ? invitations.filter((invitation) =>
        invitation.space_assignments.some((assignment) => assignment.spaceId === spaceId),
      )
    : invitations;
  const editParam = useModalTarget("invitation", canEdit ? visible : undefined);
  const editing = editParam.target;
  const canceling = visible.find((invitation) => invitation.id === cancelingId);
  const spaceName = (id: string) => spaceLabelOf(id) ?? t("orgSettings.assignmentUnavailableSpace");

  const cancel = useCancelInvitation();

  // Resolved on click: the origin is a browser fact, and nothing on screen
  // shows the clipboard changed, hence the toast. A refused copy toasts its own
  // error instead.
  const copyLink = async (invitation: Invitation) => {
    if (await copy(invitationUrl(invitation.token))) {
      toast.success(t("orgSettings.invitationLinkCopied"));
    }
  };

  const columns = useInvitationColumns({
    assignmentsLoading: spacesLoading || rolesLoading,
    assignments: (invitation) =>
      invitation.space_assignments.map(
        (assignment) =>
          `${spaceName(assignment.spaceId)} · ${
            roles.find((role) => role.value === spaceRoleValue(assignment))?.label ??
            t("orgSettings.assignmentUnavailableRole")
          }`,
      ),
    canEdit,
    isCanceling: cancel.isPending,
    onEdit: (invitation) => editParam.open(invitation.id),
    onCopyLink: (invitation) => void copyLink(invitation),
    onCancel: (invitation) => setCancelingId(invitation.id),
  });

  if (!canInvite || visible.length === 0) return null;

  return (
    <SettingsGroup title={t("orgSettings.pendingInvitations")} className="mt-8">
      <DataTable
        label={t("orgSettings.pendingInvitations")}
        tableId="invitations"
        columns={columns}
        rows={visible}
        rowKey={(invitation) => invitation.id}
        rowAction={canEdit ? (invitation) => editParam.open(invitation.id) : undefined}
        rowLabel={(invitation) => t("orgSettings.editInvitationOf", { email: invitation.email })}
        isLoading={false}
      />
      {editing && (
        <Modal
          onClose={editParam.close}
          title={t("orgSettings.editInvitation")}
          className="max-h-[85dvh] overflow-y-auto sm:max-w-xl"
        >
          <OrgInvitationForm
            key={`${orgId}:${editing.id}`}
            orgId={orgId}
            invitation={editing}
            onSuccess={editParam.close}
            onCancel={editParam.close}
          />
        </Modal>
      )}
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
                    .map((assignment) => spaceName(assignment.spaceId))
                    .join(", "),
                },
              )
            : ""
        }
        onConfirm={() => {
          if (!canceling) return;
          cancel.mutate(
            { params: { path: { orgId, invitationId: canceling.id } } },
            {
              onSuccess: () => {
                setCancelingId(null);
                toast.success(t("orgSettings.invitationCanceled"));
              },
            },
          );
        }}
      />
    </SettingsGroup>
  );
}
