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
 * drawn on a row the caller does not own is a button that answers 403. Every
 * write also guards on `integrations:connect`, whoever owns the row, and a row
 * an admin pin or the space default names refuses an unshare or a delete (409
 * `connection_pinned`): those controls stay, disabled, with the reason on them.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { DropdownMenuItem, DropdownMenuLabel } from "@appstrate/ui/components/dropdown-menu";
import { ConfirmModal } from "../components/confirm-modal";
import { DisabledReasonTooltip } from "../components/disabled-reason-tooltip";
import { InlineEditableLabel } from "../components/inline-editable-label";
import { ConnectionStatusBadge } from "../components/integration-connect/connection-status-badge";
import { InlineConnectButton } from "../components/integration-connect/inline-connect-button";
import { ConnectionDeleteImpact } from "../components/integration-connect/connection-delete-impact";
import { ConnectionTeardownSteps } from "../components/integration-connect/connection-teardown-steps";
import {
  connectionLockHintKey,
  connectionRowGrants,
} from "../components/integration-connect/connection-ownership";
import {
  useUpdateIntegrationConnection,
  type IntegrationAuthType,
  type IntegrationConnection,
} from "../hooks/use-integrations";
import { useDisconnectIntegrationConnection } from "../hooks/use-me-connections";
import { usePermissions } from "../hooks/use-permissions";
import { TableRowActions } from "../components/table-row-actions";

/** What the caller may do to this row, as the API enforces it. */
function useRowGrants(connection: IntegrationConnection, isOwn: boolean, isAdmin: boolean) {
  const { can } = usePermissions();
  const canConnect = can("integrations:connect");
  const lockKey = connectionLockHintKey(connection.locked_by);
  return {
    canConnect,
    ...connectionRowGrants({
      isOwn,
      isShared: connection.shared_with_org === true,
      canConnect,
      canConfigure: isAdmin,
      locked: !!connection.locked_by,
    }),
    lockKey,
  };
}

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
 * shared `InlineEditableLabel`. The label cannot be cleared: a run addresses
 * each bound connection by it, so an emptied field just cancels the edit.
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
  const { canRename } = useRowGrants(connection, isOwn, isAdmin);

  return (
    <div className="min-w-0">
      {/* `label` is the single source of truth (set at creation to the identity
          or "Connexion N"); render it verbatim. */}
      <InlineEditableLabel
        value={connection.label}
        editable={canRename}
        placeholder={t("integration.connection.labelPlaceholder")}
        testId={`label-edit-${connection.id}`}
        onSave={async (next) => {
          await updateConnection.mutateAsync({
            params: { path: { packageId, connectionId: connection.id } },
            body: { label: next },
          });
        }}
      />
    </div>
  );
}

/** Connected, or needing a reconnection its owner alone can perform. */
export function StatusCell({ connection }: { connection: IntegrationConnection }) {
  const { t } = useTranslation("settings");
  return (
    <div className="flex min-w-0 items-center gap-2">
      {connection.needs_reconnection ? (
        <ConnectionStatusBadge tone="needsReconnection">
          {t("integration.auth.needsReconnection")}
        </ConnectionStatusBadge>
      ) : (
        <ConnectionStatusBadge tone="connected">
          {t("integration.connection.statusConnected")}
        </ConnectionStatusBadge>
      )}
    </div>
  );
}

/**
 * The org-share consent, as the control itself.
 *
 * The sentence the checkbox used to carry is the column's header now, which is
 * what a table is for — repeated on every row it wrapped onto two lines and
 * made the row twice as tall. Sharing is the owner's consent; a governor can
 * only withdraw one. A row the caller may not toggle shows the state without
 * the control, and a locked row keeps it disabled with the reason on it.
 */
export function SharedCell({
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
  const { canToggleShare, shareLocked, lockKey } = useRowGrants(connection, isOwn, isAdmin);
  return (
    <DisabledReasonTooltip reason={shareLocked && lockKey ? t(lockKey) : null}>
      <Checkbox
        checked={connection.shared_with_org === true}
        disabled={!canToggleShare || shareLocked || updateConnection.isPending}
        onCheckedChange={(next) =>
          updateConnection.mutate({
            params: { path: { packageId, connectionId: connection.id } },
            body: { shared_with_org: next === true },
          })
        }
        aria-label={t("integration.connection.shareWithOrg.label")}
        title={
          !canToggleShare || shareLocked
            ? undefined
            : t(
                isOwn
                  ? "integration.connection.shareWithOrg.help"
                  : "integration.connection.shareWithOrg.unshareHelp",
              )
        }
        data-testid={`share-toggle-${connection.id}`}
      />
    </DisabledReasonTooltip>
  );
}

/** Reconnect direct when needed; destructive disconnect stays in the menu. */
export function ConnectionActionsCell({
  connection,
  packageId,
  authKey,
  authType,
  canRenew,
  isOwn,
  isAdmin,
}: {
  connection: IntegrationConnection;
  packageId: string;
  authKey: string;
  authType: IntegrationAuthType;
  canRenew: boolean;
  isOwn: boolean;
  isAdmin: boolean;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const disconnect = useDisconnectIntegrationConnection();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { canConnect, lockKey } = useRowGrants(connection, isOwn, isAdmin);
  if (!isOwn) return <span className="text-muted-foreground text-xs">—</span>;
  // An admin pin or the space default names the row: deleting it is refused
  // until it is removed from there.
  const lockHint = lockKey ? t(lockKey) : null;
  return (
    <>
      <div className="relative z-10 flex items-center justify-end gap-1">
        {connection.needs_reconnection && canConnect && canRenew && authType === "oauth2" && (
          <InlineConnectButton
            packageId={packageId}
            authKey={authKey}
            intent="reconnect"
            connectionId={connection.id}
            lockToAuthKey
            iconOnly
          />
        )}
        <TableRowActions
          menuLabel={t("integration.connection.moreActions", { name: connection.label })}
          isPending={disconnect.isPending}
          pendingLabel={t("common:loading")}
        >
          <DropdownMenuItem
            onSelect={() => setConfirmDelete(true)}
            disabled={disconnect.isPending || !!lockHint}
            className="text-destructive focus:text-destructive"
            data-testid={`connection-delete-${connection.id}`}
          >
            <Trash2 />
            {t("integration.connection.delete")}
          </DropdownMenuItem>
          {/* Said in the menu, where the dead item is: a disabled item takes no hover. */}
          {lockHint && (
            <DropdownMenuLabel className="text-muted-foreground max-w-64 text-xs font-normal">
              {lockHint}
            </DropdownMenuLabel>
          )}
        </TableRowActions>
      </div>
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
      >
        {confirmDelete && (
          <>
            <ConnectionDeleteImpact connectionId={connection.id} />
            <ConnectionTeardownSteps connectionId={connection.id} />
          </>
        )}
      </ConfirmModal>
    </>
  );
}
