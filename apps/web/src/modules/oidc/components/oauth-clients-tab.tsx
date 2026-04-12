// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth clients admin tab for org/app settings pages.
 * Lists registered clients and lets admins register, edit, rotate secrets
 * for, disable, and delete them.
 *
 * Feature-gated by `features.oidc` at the parent tab level — this component
 * should never render when the OIDC module is absent.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, RotateCcw, Power, KeyRound, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadingState, ErrorState, EmptyState } from "@/components/page-states";
import { Spinner } from "@/components/spinner";
import { Modal } from "@/components/modal";
import { SecretRevealModal } from "@/components/secret-reveal-modal";
import { usePermissions } from "@/hooks/use-permissions";
import {
  useOAuthClients,
  useUpdateOAuthClient,
  useDeleteOAuthClient,
  useRotateOAuthClientSecret,
  type OAuthClient,
} from "../hooks/use-oauth-clients";
import { OAuthClientFormModal } from "./oauth-client-form-modal";

interface OAuthClientsTabProps {
  level?: "org" | "application";
}

export function OAuthClientsTab({ level }: OAuthClientsTabProps) {
  const { t } = useTranslation(["settings", "common"]);
  const { data, isLoading, error } = useOAuthClients(level);

  const [modalOpen, setModalOpen] = useState(false);
  const [editClient, setEditClient] = useState<OAuthClient | null>(null);

  const openCreate = () => {
    setEditClient(null);
    setModalOpen(true);
  };
  const openEdit = (client: OAuthClient) => {
    setEditClient(client);
    setModalOpen(true);
  };

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;
  if (!data) return <ErrorState />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground max-w-xl text-sm">{t("settings:oauthClients.intro")}</p>
        <Button size="sm" onClick={openCreate}>
          <Plus className="h-4 w-4" /> {t("settings:oauthClients.createBtn")}
        </Button>
      </div>

      {data.length === 0 ? (
        <EmptyState message={t("settings:oauthClients.empty")} icon={KeyRound}>
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4" /> {t("settings:oauthClients.createBtn")}
          </Button>
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {data.map((client) => (
            <OAuthClientRow key={client.clientId} client={client} onEdit={() => openEdit(client)} />
          ))}
        </ul>
      )}

      <OAuthClientFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        client={editClient}
        level={level}
      />
    </div>
  );
}

function OAuthClientRow({ client, onEdit }: { client: OAuthClient; onEdit: () => void }) {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();
  const updateMutation = useUpdateOAuthClient();
  const deleteMutation = useDeleteOAuthClient();
  const rotateMutation = useRotateOAuthClientSecret();

  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);
  const [rotateConfirmOpen, setRotateConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  function handleToggleDisabled() {
    updateMutation.mutate(
      { clientId: client.clientId, data: { disabled: !client.disabled } },
      {
        onSuccess: () => {
          toast.success(
            client.disabled
              ? t("settings:oauthClients.enabled")
              : t("settings:oauthClients.disabled"),
          );
        },
      },
    );
  }

  function handleRotate() {
    rotateMutation.mutate(client.clientId, {
      onSuccess: (result) => {
        setRotateConfirmOpen(false);
        setRotatedSecret(result.clientSecret);
      },
    });
  }

  function handleDelete() {
    deleteMutation.mutate(client.clientId, {
      onSuccess: () => {
        setDeleteConfirmOpen(false);
        toast.success(t("settings:oauthClients.deleted"));
      },
    });
  }

  return (
    <li className="border-border bg-card space-y-3 rounded-lg border p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-semibold">{client.name ?? client.clientId}</h3>
            {client.isFirstParty && (
              <Badge variant="outline">
                <ShieldCheck className="mr-1 h-3 w-3" />
                {t("settings:oauthClients.firstPartyBadge")}
              </Badge>
            )}
            {client.disabled && (
              <Badge variant="secondary">{t("settings:oauthClients.disabledBadge")}</Badge>
            )}
          </div>
          <p className="text-muted-foreground mt-1 font-mono text-xs break-all">
            {client.clientId}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" onClick={onEdit} title={t("common:btn.edit")}>
            <Pencil className="h-4 w-4" />
          </Button>
          {isAdmin && (
            <Button
              size="sm"
              variant={client.isFirstParty ? "default" : "outline"}
              onClick={() =>
                updateMutation.mutate(
                  { clientId: client.clientId, data: { isFirstParty: !client.isFirstParty } },
                  {
                    onSuccess: () => {
                      toast.success(
                        client.isFirstParty
                          ? t("settings:oauthClients.firstPartyDisabled")
                          : t("settings:oauthClients.firstPartyEnabled"),
                      );
                    },
                  },
                )
              }
              disabled={updateMutation.isPending}
              title={t("settings:oauthClients.toggleFirstParty")}
            >
              <ShieldCheck className="h-4 w-4" />
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={handleToggleDisabled}
            disabled={updateMutation.isPending}
            title={
              client.disabled
                ? t("settings:oauthClients.enable")
                : t("settings:oauthClients.disable")
            }
          >
            <Power className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRotateConfirmOpen(true)}
            disabled={rotateMutation.isPending}
            title={t("settings:oauthClients.rotate")}
          >
            <RotateCcw className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setDeleteConfirmOpen(true)}
            disabled={deleteMutation.isPending}
            title={t("common:btn.delete")}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div>
        <p className="text-muted-foreground mb-1 text-xs font-medium uppercase">
          {t("settings:oauthClients.redirectUris")}
        </p>
        <ul className="space-y-1">
          {client.redirectUris.map((uri) => (
            <li key={uri} className="bg-muted rounded px-2 py-1 font-mono text-xs break-all">
              {uri}
            </li>
          ))}
        </ul>
      </div>

      {client.postLogoutRedirectUris.length > 0 && (
        <div>
          <p className="text-muted-foreground mb-1 text-xs font-medium uppercase">
            {t("settings:oauthClients.postLogoutRedirectUris")}
          </p>
          <ul className="space-y-1">
            {client.postLogoutRedirectUris.map((uri) => (
              <li key={uri} className="bg-muted rounded px-2 py-1 font-mono text-xs break-all">
                {uri}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Modal
        open={rotateConfirmOpen}
        onClose={() => setRotateConfirmOpen(false)}
        title={t("settings:oauthClients.rotateConfirmTitle")}
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
        <p className="text-muted-foreground text-sm">{t("settings:oauthClients.rotateConfirm")}</p>
      </Modal>

      {rotatedSecret && (
        <SecretRevealModal
          open={!!rotatedSecret}
          onClose={() => setRotatedSecret(null)}
          title={t("settings:oauthClients.newSecret")}
          secret={rotatedSecret}
        />
      )}

      <Modal
        open={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        title={t("settings:oauthClients.deleteConfirmTitle")}
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
        <p className="text-muted-foreground text-sm">{t("settings:oauthClients.deleteConfirm")}</p>
      </Modal>
    </li>
  );
}
