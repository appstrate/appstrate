// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Power, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@appstrate/ui/components/dropdown-menu";
import { getErrorMessage } from "@appstrate/core/errors";
import { ConfirmModal } from "../../../components/confirm-modal";
import { SecretRevealModal } from "../../../components/secret-reveal-modal";
import { TableRowActions } from "../../../components/table-row-actions";
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
  const { isAdmin } = usePermissions();
  const updateMutation = useUpdateOAuthClient();
  const deleteMutation = useDeleteOAuthClient();
  const rotateMutation = useRotateOAuthClientSecret();
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);
  const [rotateConfirmOpen, setRotateConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  function handleUpdate(body: { disabled?: boolean; isFirstParty?: boolean }) {
    updateMutation.mutate(
      { params: { path: { clientId: client.clientId } }, body },
      { onError: (error) => toast.error(getErrorMessage(error)) },
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
        onError: (error) => toast.error(getErrorMessage(error)),
      },
    );
  }

  function handleDelete() {
    deleteMutation.mutate(
      { params: { path: { clientId: client.clientId } } },
      {
        onSuccess: () => {
          setDeleteConfirmOpen(false);
        },
        onError: (error) => toast.error(getErrorMessage(error)),
      },
    );
  }

  const rowName = client.name ?? client.clientId;
  const isPending =
    updateMutation.isPending || deleteMutation.isPending || rotateMutation.isPending;

  return (
    <>
      <TableRowActions
        primary={{ label: t("common:btn.edit"), onSelect: onEdit }}
        menuLabel={t("oauthClients.moreActions", { name: rowName })}
        isPending={isPending}
        pendingLabel={t("common:loading")}
      >
        {isAdmin && (
          <DropdownMenuItem
            onSelect={() => handleUpdate({ isFirstParty: !client.isFirstParty })}
            disabled={updateMutation.isPending}
          >
            <ShieldCheck />
            {client.isFirstParty
              ? t("oauthClients.removeFirstParty")
              : t("oauthClients.makeFirstParty")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onSelect={() => handleUpdate({ disabled: !client.disabled })}
          disabled={updateMutation.isPending}
        >
          <Power />
          {client.disabled ? t("oauthClients.enable") : t("oauthClients.disable")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => setRotateConfirmOpen(true)}
          disabled={rotateMutation.isPending}
        >
          <RotateCcw />
          {t("oauthClients.rotate")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => setDeleteConfirmOpen(true)}
          disabled={deleteMutation.isPending}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 />
          {t("common:btn.delete")}
        </DropdownMenuItem>
      </TableRowActions>

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
          open
          onClose={() => setRotatedSecret(null)}
          title={t("oauthClients.newSecret")}
          secret={rotatedSecret}
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
