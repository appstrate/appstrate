// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Power, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@appstrate/ui/components/dropdown-menu";
import type { DataColumn } from "@/components/data-table";
import { Modal } from "@/components/modal";
import { SecretRevealModal } from "@/components/secret-reveal-modal";
import { Spinner } from "@/components/spinner";
import { TableRowActions } from "@/components/table-row-actions";
import { usePermissions } from "@/hooks/use-permissions";
import {
  useDeleteOAuthClient,
  useRotateOAuthClientSecret,
  useUpdateOAuthClient,
  type OAuthClient,
} from "../hooks/use-oauth-clients";

export function useOAuthClientColumns({
  onEdit,
}: {
  onEdit: (client: OAuthClient) => void;
}): DataColumn<OAuthClient>[] {
  const { t } = useTranslation(["settings", "common"]);

  return [
    {
      id: "client",
      header: t("oauthClients.nameLabel"),
      width: "minmax(160px,1.5fr)",
      cell: (client) => (
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium">{client.name ?? client.clientId}</span>
            {client.isFirstParty && (
              <Badge variant="outline">
                <ShieldCheck className="mr-1 h-3 w-3" />
                {t("oauthClients.firstPartyBadge")}
              </Badge>
            )}
            {client.disabled && (
              <Badge variant="secondary">{t("oauthClients.disabledBadge")}</Badge>
            )}
          </div>
          <div className="text-muted-foreground truncate font-mono text-xs" title={client.clientId}>
            {client.clientId}
          </div>
        </div>
      ),
    },
    {
      id: "redirectUris",
      header: t("oauthClients.redirectUris"),
      width: "minmax(180px,1.5fr)",
      tier: 2,
      cell: (client) => {
        const label = client.redirectUris.join(", ");
        return (
          <span className="text-muted-foreground truncate font-mono text-xs" title={label}>
            {client.redirectUris[0]}
            {client.redirectUris.length > 1 && ` +${client.redirectUris.length - 1}`}
          </span>
        );
      },
    },
    {
      id: "actions",
      header: "",
      width: "72px",
      align: "end",
      cell: (client) => <OAuthClientActions client={client} onEdit={() => onEdit(client)} />,
    },
  ];
}

function OAuthClientActions({ client, onEdit }: { client: OAuthClient; onEdit: () => void }) {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();
  const updateMutation = useUpdateOAuthClient();
  const deleteMutation = useDeleteOAuthClient();
  const rotateMutation = useRotateOAuthClientSecret();
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);
  const [rotateConfirmOpen, setRotateConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  function handleUpdate(body: { disabled?: boolean; isFirstParty?: boolean }, message: string) {
    updateMutation.mutate(
      { params: { path: { clientId: client.clientId } }, body },
      { onSuccess: () => toast.success(message) },
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

  return (
    <>
      <TableRowActions
        primary={{ label: t("common:btn.edit"), onSelect: onEdit }}
        menuLabel={t("oauthClients.moreActions", { name: rowName })}
      >
        {isAdmin && (
          <DropdownMenuItem
            onSelect={() =>
              handleUpdate(
                { isFirstParty: !client.isFirstParty },
                client.isFirstParty
                  ? t("oauthClients.firstPartyDisabled")
                  : t("oauthClients.firstPartyEnabled"),
              )
            }
            disabled={updateMutation.isPending}
          >
            <ShieldCheck />
            {client.isFirstParty
              ? t("oauthClients.removeFirstParty")
              : t("oauthClients.makeFirstParty")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onSelect={() =>
            handleUpdate(
              { disabled: !client.disabled },
              client.disabled ? t("oauthClients.enabled") : t("oauthClients.disabled"),
            )
          }
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

      <Modal
        open={rotateConfirmOpen}
        onClose={() => setRotateConfirmOpen(false)}
        title={t("oauthClients.rotateConfirmTitle")}
        actions={
          <>
            <Button variant="outline" onClick={() => setRotateConfirmOpen(false)}>
              {t("common:btn.cancel")}
            </Button>
            <Button onClick={handleRotate} disabled={rotateMutation.isPending}>
              {rotateMutation.isPending ? <Spinner /> : t("common:btn.confirm")}
            </Button>
          </>
        }
      >
        <p className="text-muted-foreground text-sm">{t("oauthClients.rotateConfirm")}</p>
      </Modal>

      {rotatedSecret && (
        <SecretRevealModal
          open
          onClose={() => setRotatedSecret(null)}
          title={t("oauthClients.newSecret")}
          secret={rotatedSecret}
        />
      )}

      <Modal
        open={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        title={t("oauthClients.deleteConfirmTitle")}
        actions={
          <>
            <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)}>
              {t("common:btn.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? <Spinner /> : t("common:btn.confirm")}
            </Button>
          </>
        }
      >
        <p className="text-muted-foreground text-sm">{t("oauthClients.deleteConfirm")}</p>
      </Modal>
    </>
  );
}
