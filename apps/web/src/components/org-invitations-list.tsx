// SPDX-License-Identifier: Apache-2.0

import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getErrorMessage } from "@appstrate/core/errors";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import type { components } from "../api/client";
import { $api } from "../api/client";
import { useOrg } from "../hooks/use-org";
import { usePermissions } from "../hooks/use-permissions";
import { roleI18nKey } from "../hooks/use-permissions";
import { useSpaces } from "../hooks/use-spaces";
import { spaceRoleValue, useSpaceRoleOptions } from "../hooks/use-roles";
import { ConfirmModal } from "./confirm-modal";
import { CopyLinkButton } from "./copy-link-button";
import { Modal } from "./modal";
import { OrgInvitationForm } from "./org-invitation-form";

type Invitation = components["schemas"]["OrgInvitationInfo"];

/** Organization and space pages show the same pending invitation, not a second membership. */
export function OrgInvitationsList({
  orgId,
  invitations,
  spaceId,
}: {
  orgId: string;
  invitations: Invitation[];
  spaceId?: string;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const headingId = useId();
  const queryClient = useQueryClient();
  const { currentOrg } = useOrg();
  const { can } = usePermissions();
  const { data: spaces } = useSpaces();
  const { options: roles } = useSpaceRoleOptions();
  const canInvite = currentOrg?.id === orgId && can("members:invite");
  const canEdit = currentOrg?.id === orgId && can("members:change-role");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const visibleInvitations = spaceId
    ? invitations.filter((invitation) =>
        invitation.space_assignments.some((assignment) => assignment.space_id === spaceId),
      )
    : invitations;
  const editing = visibleInvitations.find((invitation) => invitation.id === editingId);
  const canceling = visibleInvitations.find((invitation) => invitation.id === cancelingId);
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

  // Tokens are organization invitation authority, even when this list is shown in a space.
  if (!canInvite || visibleInvitations.length === 0) return null;

  return (
    <section aria-labelledby={headingId} className="mt-6 flex flex-col gap-3">
      <h2 id={headingId} className="text-sm font-semibold">
        {t("orgSettings.pendingInvitations")}
      </h2>
      {visibleInvitations.map((invitation) => (
        <article
          key={invitation.id}
          data-invitation-id={invitation.id}
          className="border-border bg-card flex min-w-0 flex-col gap-3 rounded-lg border p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="min-w-0 text-sm font-semibold wrap-anywhere">{invitation.email}</h3>
            <Badge variant="pending">{t("orgSettings.invited")}</Badge>
          </div>
          <dl className="grid gap-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-4">
            <dt className="text-muted-foreground">{t("orgSettings.organizationAccess")}</dt>
            <dd>
              {t(
                invitation.role === "guest"
                  ? "orgSettings.guestLimitedAccess"
                  : roleI18nKey(invitation.role),
              )}
            </dd>
            {invitation.space_assignments.length > 0 && (
              <>
                <dt className="text-muted-foreground">{t("orgSettings.assignedSpaceRoles")}</dt>
                <dd>
                  <ul className="flex flex-col gap-1">
                    {invitation.space_assignments.map((assignment) => (
                      <li key={assignment.space_id} className="break-words">
                        {spaceName(assignment.space_id)} —{" "}
                        {roles.find((role) => role.value === spaceRoleValue(assignment))?.label ??
                          t("orgSettings.assignmentUnavailableRole")}
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
          </dl>
          <div className="border-border flex flex-wrap gap-2 border-t pt-3">
            {canEdit && (
              <Button variant="outline" size="sm" onClick={() => setEditingId(invitation.id)}>
                {t("common:btn.edit")}
              </Button>
            )}
            <CopyLinkButton token={invitation.token} />
            <Button
              variant="destructive"
              size="sm"
              className="sm:ml-auto"
              disabled={cancel.isPending}
              onClick={() => setCancelingId(invitation.id)}
            >
              {t("orgSettings.cancelInvitation")}
            </Button>
          </div>
        </article>
      ))}
      {editing && (
        <Modal
          open
          onClose={() => setEditingId(null)}
          title={t("orgSettings.editInvitation")}
          className="max-h-[85dvh] overflow-y-auto sm:max-w-xl"
        >
          <OrgInvitationForm
            key={`${orgId}:${editing.id}`}
            orgId={orgId}
            invitation={editing}
            onSuccess={() => setEditingId(null)}
            onCancel={() => setEditingId(null)}
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
    </section>
  );
}
