// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Pencil, Power, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import { ConfirmModal } from "../../../components/confirm-modal";
import { SecretRevealModal } from "../../../components/secret-reveal-modal";
import { TableRowActions } from "../../../components/table-row-actions";
import type { MenuAction } from "../../../lib/menu-action";
import { usePermissions } from "../../../hooks/use-permissions";
import {
  useDeleteOAuthClient,
  useRotateOAuthClientSecret,
  useUpdateOAuthClient,
  type OAuthClient,
} from "../hooks/use-oauth-clients";

export function OAuthClientActions({
  client,
  onEdit,
}: {
  client: OAuthClient;
  onEdit: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const canWrite = can("oauth-clients:write");
  const canDelete = can("oauth-clients:delete");
  const updateMutation = useUpdateOAuthClient();
  const deleteMutation = useDeleteOAuthClient();
  const rotateMutation = useRotateOAuthClientSecret();
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);
  const [rotateConfirmOpen, setRotateConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  function handleUpdate(body: { disabled: boolean } | { isFirstParty: boolean }, done: string) {
    updateMutation.mutate(
      { params: { path: { clientId: client.clientId } }, body },
      { onSuccess: () => toast.success(done) },
    );
  }

  function handleRotate() {
    rotateMutation.mutate(
      { params: { path: { clientId: client.clientId } } },
      {
        onSuccess: (result) => {
          setRotateConfirmOpen(false);
          setRotatedSecret(result.clientSecret);
        },
      },
    );
  }

  function handleDelete() {
    deleteMutation.mutate(
      { params: { path: { clientId: client.clientId } } },
      {
        onSuccess: () => {
          setDeleteConfirmOpen(false);
          toast.success(t("oauthClients.deleted"));
        },
      },
    );
  }

  const rowName = client.name ?? client.clientId;
  const isPending =
    updateMutation.isPending || deleteMutation.isPending || rotateMutation.isPending;

  // Every hook above, THEN this: a row the caller can neither change nor
  // delete has no menu at all.
  if (!canWrite && !canDelete) return null;

  const actions: MenuAction[] = [
    {
      id: "edit",
      label: t("common:btn.edit"),
      icon: Pencil,
      onSelect: onEdit,
      hidden: !canWrite,
    },
    {
      id: "first-party",
      label: client.isFirstParty
        ? t("oauthClients.removeFirstParty")
        : t("oauthClients.makeFirstParty"),
      icon: ShieldCheck,
      onSelect: () =>
        handleUpdate(
          { isFirstParty: !client.isFirstParty },
          t(
            client.isFirstParty
              ? "oauthClients.firstPartyDisabled"
              : "oauthClients.firstPartyEnabled",
          ),
        ),
      disabled: updateMutation.isPending,
      hidden: !canWrite,
    },
    {
      id: "toggle-disabled",
      label: client.disabled ? t("oauthClients.enable") : t("oauthClients.disable"),
      icon: Power,
      onSelect: () =>
        handleUpdate(
          { disabled: !client.disabled },
          t(client.disabled ? "oauthClients.enabled" : "oauthClients.disabled"),
        ),
      disabled: updateMutation.isPending,
      hidden: !canWrite,
    },
    {
      id: "rotate",
      label: t("oauthClients.rotate"),
      icon: RotateCcw,
      onSelect: () => setRotateConfirmOpen(true),
      disabled: rotateMutation.isPending,
      hidden: !canWrite,
    },
    {
      id: "delete",
      label: t("common:btn.delete"),
      icon: Trash2,
      onSelect: () => setDeleteConfirmOpen(true),
      disabled: deleteMutation.isPending,
      destructive: true,
      hidden: !canDelete,
    },
  ];

  return (
    <>
      <TableRowActions
        menuLabel={t("oauthClients.moreActions", { name: rowName })}
        isPending={isPending}
        actions={actions}
      />

      <ConfirmModal
        open={rotateConfirmOpen}
        onClose={() => setRotateConfirmOpen(false)}
        title={t("oauthClients.rotateConfirmTitle")}
        description={t("oauthClients.rotateConfirm")}
        variant="default"
        isPending={rotateMutation.isPending}
        onConfirm={handleRotate}
      />

      {rotatedSecret && (
        <SecretRevealModal
          onClose={() => setRotatedSecret(null)}
          title={t("oauthClients.newSecret")}
          secret={rotatedSecret}
          warning={t("oauthClients.secretWarning")}
        />
      )}

      <ConfirmModal
        open={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        title={t("oauthClients.deleteConfirmTitle")}
        description={t("oauthClients.deleteConfirm")}
        isPending={deleteMutation.isPending}
        onConfirm={handleDelete}
      />
    </>
  );
}
