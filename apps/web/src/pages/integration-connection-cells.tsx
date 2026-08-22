// SPDX-License-Identifier: Apache-2.0

/**
 * The controls a connected-account row is made of.
 *
 * They are components rather than closures inside the column set because each
 * one owns state or a mutation, and `cell` is called during the table's render
 * — a hook in there would be a hook inside a loop. Splitting them out of
 * `integration-columns.tsx` also keeps that file what its siblings are: column
 * DATA, exporting nothing but its two hooks.
 *
 * Ownership is the rule that decides most of them, and it is passed in rather
 * than re-derived: the list returns org-shared rows owned by OTHER members, and
 * delete, share and reconnect are all owner-only server-side, so a control
 * drawn on a row the caller does not own is a button that answers 403.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Input } from "@appstrate/ui/components/input";
import { ConfirmModal } from "../components/confirm-modal";
import { ConnectionStatusBadge } from "../components/integration-connect/connection-status-badge";
import { InlineConnectButton } from "../components/integration-connect/inline-connect-button";
import { connectionDisplayLabel } from "../components/integration-connect/connection-label";
import {
  useUpdateIntegrationConnection,
  type IntegrationAuthType,
  type IntegrationConnection,
} from "../hooks/use-integrations";
import { useDisconnectIntegrationConnection } from "../hooks/use-me-connections";

/**
 * The account, renamed in place. Renaming is owner OR org admin — the same rule
 * the route enforces — while sharing and deleting are strictly the owner's.
 */
export function AccountCell({
  connection,
  packageId,
  isOwn,
  isAdmin,
}: {
  connection: IntegrationConnection;
  packageId: string;
  isOwn: boolean;
  isAdmin: boolean;
}) {
  const { t } = useTranslation("settings");
  const updateConnection = useUpdateIntegrationConnection();
  const [editing, setEditing] = useState(false);
  const [draftLabel, setDraftLabel] = useState(connection.label ?? "");
  // `label` is the single source of truth (set at creation to the identity or
  // "Connexion N"); render it verbatim.
  const name = connectionDisplayLabel(connection);

  const cancelEdit = () => {
    setEditing(false);
    setDraftLabel(connection.label ?? "");
  };
  const submitLabel = () => {
    const next = draftLabel.trim();
    if (next === (connection.label ?? "")) {
      setEditing(false);
      return;
    }
    updateConnection.mutate(
      {
        params: { path: { packageId, connectionId: connection.id } },
        body: { label: next === "" ? null : next },
      },
      { onSuccess: () => setEditing(false) },
    );
  };

  if (editing) {
    return (
      <div className="flex min-w-0 items-center gap-1">
        <Input
          value={draftLabel}
          onChange={(e) => setDraftLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitLabel();
            if (e.key === "Escape") cancelEdit();
          }}
          placeholder={t("integration.connection.labelPlaceholder")}
          className="h-7 min-w-0 text-sm"
          autoFocus
          data-testid={`label-input-${connection.id}`}
        />
        <Button
          size="icon"
          variant="ghost"
          className="size-7 shrink-0"
          onClick={submitLabel}
          disabled={updateConnection.isPending}
          title={t("integration.connection.labelSave")}
          data-testid={`label-save-${connection.id}`}
        >
          <Check className="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7 shrink-0"
          onClick={cancelEdit}
          disabled={updateConnection.isPending}
          title={t("integration.connection.labelCancel")}
        >
          <X className="size-3.5" />
        </Button>
      </div>
    );
  }

  return (
    // Two lines, like the models table's identity cell, and for a reason a
    // measurement gave: whose connection it is used to be a badge BESIDE the
    // name, and a badge that refuses to shrink takes the whole column — at a
    // 390px window the account name, the only thing naming the row, rendered at
    // zero width while "Partagée par Pierre" kept every pixel. The name owns
    // line one; the owner is what it is, provenance, and reads under it.
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-1">
        <span className="truncate font-medium">{name}</span>
        {(isOwn || isAdmin) && (
          <Button
            size="icon"
            variant="ghost"
            className="size-6 shrink-0"
            onClick={() => {
              setDraftLabel(connection.label ?? "");
              setEditing(true);
            }}
            title={t("integration.connection.labelEdit")}
            data-testid={`label-edit-${connection.id}`}
          >
            <Pencil className="size-3" />
          </Button>
        )}
      </div>
      {!isOwn && (
        <div
          className="text-muted-foreground truncate text-[0.65rem]"
          data-testid={`connection-owner-${connection.id}`}
        >
          {connection.owner_name
            ? t("integration.connection.sharedByOwner", { owner: connection.owner_name })
            : t("integration.connection.sharedByUnknown")}
        </div>
      )}
    </div>
  );
}

/** Connected, or needing a reconnection its owner alone can perform. */
export function StatusCell({
  connection,
  packageId,
  authKey,
  authType,
  canRenew,
  isOwn,
}: {
  connection: IntegrationConnection;
  packageId: string;
  authKey: string;
  authType: IntegrationAuthType;
  canRenew: boolean;
  isOwn: boolean;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {connection.needs_reconnection ? (
          <>
            <ConnectionStatusBadge tone="needsReconnection">
              {t("integration.auth.needsReconnection")}
            </ConnectionStatusBadge>
            {/* Owner-only: the reconnect writes through `persistCredentialBundle`
                kind `update-owned`, whose WHERE carries the actor identity — a
                non-owner reconnect 404s. Others see the state without a dead
                CTA. */}
            {isOwn && canRenew && authType === "oauth2" && (
              <InlineConnectButton
                packageId={packageId}
                authKey={authKey}
                intent="reconnect"
                // Threading the existing row id is what makes the OAuth callback
                // UPDATE-in-place rather than INSERT a duplicate
                // (integration-connections.ts:721 "explicit connectionId =
                // update; no id = insert").
                connectionId={connection.id}
                lockToAuthKey
                size="sm"
              />
            )}
          </>
        ) : (
          <ConnectionStatusBadge tone="connected">
            {t("integration.connection.statusConnected")}
          </ConnectionStatusBadge>
        )}
      </div>
      {connection.expiresAt && (
        <p className="text-muted-foreground text-[0.65rem]">
          {t("integration.auth.expiresAt", {
            date: new Date(connection.expiresAt).toLocaleDateString(),
          })}
        </p>
      )}
    </div>
  );
}

/**
 * The org-share consent, as the control itself.
 *
 * The sentence the checkbox used to carry is the column's header now, which is
 * what a table is for — repeated on every row it wrapped onto two lines and
 * made the row twice as tall. A row the caller does not own shows the state
 * without the control: sharing is the owner's consent, and the API says so.
 */
export function SharedCell({
  connection,
  packageId,
  isOwn,
}: {
  connection: IntegrationConnection;
  packageId: string;
  isOwn: boolean;
}) {
  const { t } = useTranslation("settings");
  const updateConnection = useUpdateIntegrationConnection();
  const isShared = connection.shared_with_org === true;
  return (
    <Checkbox
      checked={isShared}
      disabled={!isOwn || updateConnection.isPending}
      onCheckedChange={(next) =>
        updateConnection.mutate({
          params: { path: { packageId, connectionId: connection.id } },
          body: { shared_with_org: next === true },
        })
      }
      aria-label={t("integration.connection.shareWithOrg.label")}
      title={t("integration.connection.shareWithOrg.help")}
      data-testid={`share-toggle-${connection.id}`}
    />
  );
}

/** Disconnect — owner-only: the endpoint is `/api/me/connections`. */
export function DisconnectCell({
  connection,
  isOwn,
}: {
  connection: IntegrationConnection;
  isOwn: boolean;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const disconnect = useDisconnectIntegrationConnection();
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (!isOwn) return <span className="text-muted-foreground text-xs">—</span>;
  return (
    <>
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        onClick={() => setConfirmDelete(true)}
        disabled={disconnect.isPending}
        title={t("integration.connection.delete")}
        data-testid={`connection-delete-${connection.id}`}
      >
        <Trash2 className="text-destructive size-3.5" />
      </Button>
      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t("btn.confirm", { ns: "common" })}
        description={t("integration.connection.deleteConfirm")}
        isPending={disconnect.isPending}
        onConfirm={() =>
          disconnect.mutate(
            { params: { path: { connectionId: connection.id } } },
            { onSuccess: () => setConfirmDelete(false) },
          )
        }
      />
    </>
  );
}
