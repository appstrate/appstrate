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
import { Trash2 } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { ConfirmModal } from "../components/confirm-modal";
import { InlineEditableLabel } from "../components/inline-editable-label";
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
 * The account, renamed in place.
 *
 * Renaming is owner OR org admin — the same rule the route enforces — while
 * sharing and deleting are strictly the owner's.
 *
 * It used to be a pencil that swapped the label for an input, which is the Edit
 * button the product owner ruled out ("Direct manipulation in forms. No Edit
 * button revealing a field"), and it left the app with two rename affordances:
 * click-to-edit on the credentials table, pencil-then-field here. One now, the
 * shared `InlineEditableLabel`, which grew truncation and a clearable value to
 * take this caller — clearing matters here because a connection with no label
 * falls back to its account id.
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
  // `label` is the single source of truth (set at creation to the identity or
  // "Connexion N"); render it verbatim.
  const name = connectionDisplayLabel(connection);

  return (
    <div className="min-w-0">
      <InlineEditableLabel
        value={name}
        editable={isOwn || isAdmin}
        allowEmpty
        placeholder={t("integration.connection.labelPlaceholder")}
        testId={`label-edit-${connection.id}`}
        onSave={async (next) => {
          await updateConnection.mutateAsync({
            params: { path: { packageId, connectionId: connection.id } },
            body: { label: next === "" ? null : next },
          });
        }}
      />
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
