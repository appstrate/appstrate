// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, Pencil, Check, X } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Badge } from "@appstrate/ui/components/badge";
import { Input } from "@appstrate/ui/components/input";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@appstrate/ui/components/table";
import { ConfirmModal } from "../confirm-modal";
import { DisabledReasonTooltip } from "../disabled-reason-tooltip";
import { ConnectionTeardownSteps } from "../integration-connect/connection-teardown-steps";
import { ConnectionDeleteImpact } from "../integration-connect/connection-delete-impact";
import { ConnectionVariablesLine } from "../integration-connect/connection-variables-line";
import { InlineConnectButton } from "../integration-connect/inline-connect-button";
import {
  connectionLockHintKey,
  connectionRowGrants,
  isConnectionOwnedBy,
} from "../integration-connect/connection-ownership";
import { ConnectionStatusBadge } from "../integration-connect/connection-status-badge";
import { summarizeScopes } from "../integration-connect/connection-scope-fit";
import { isQueryInFlight } from "../../lib/query-state";
import { usePermissions } from "../../hooks/use-permissions";
import {
  useUpdateIntegrationConnection,
  type IntegrationAuthType,
  type IntegrationConnection,
  type IntegrationManifestView,
} from "../../hooks/use-integrations";
import {
  useConnectionDeleteImpact,
  useDisconnectIntegrationConnection,
} from "../../hooks/use-me-connections";
import { useCurrentOrgId } from "../../hooks/use-org";
import { useAuth } from "../../hooks/use-auth";
import { useCurrentSpaceId } from "../../hooks/use-current-space";

/**
 * Connected accounts for one auth, as a table. Empty → a muted line. Columns:
 * account (with inline rename), status (+ reconnect when stale), granted scopes,
 * org-share toggle, and a disconnect action. All mutations are unchanged from
 * the previous card layout — only the presentation moved to a table.
 */
export function ConnectionsTable({
  packageId,
  authKey,
  authType,
  manifest,
  connections,
  canRenew,
}: {
  packageId: string;
  authKey: string;
  authType: IntegrationAuthType;
  /** Names the granted scopes by the auth's `scope_catalog`. */
  manifest: IntegrationManifestView;
  connections: IntegrationConnection[];
  canRenew: boolean;
}) {
  const { t } = useTranslation("settings");
  if (connections.length === 0)
    return <p className="text-muted-foreground text-sm">{t("integration.auth.noConnection")}</p>;
  return (
    <div className="overflow-hidden rounded-md border" data-testid={`connections-table-${authKey}`}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-xs">{t("integration.connection.col.account")}</TableHead>
            <TableHead className="text-xs">{t("integration.connection.col.status")}</TableHead>
            <TableHead className="text-xs">{t("integration.connection.col.scopes")}</TableHead>
            <TableHead className="text-xs">{t("integration.connection.col.shared")}</TableHead>
            <TableHead className="w-px text-right text-xs">
              {t("integration.connection.col.actions")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {connections.map((c) => (
            <ConnectionTableRow
              key={c.id}
              connection={c}
              packageId={packageId}
              authKey={authKey}
              authType={authType}
              manifest={manifest}
              canRenew={canRenew}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ConnectionTableRow({
  connection,
  packageId,
  authKey,
  authType,
  manifest,
  canRenew,
}: {
  connection: IntegrationConnection;
  packageId: string;
  /** Auth key the connection is bound to — forwarded to the renew CTA. */
  authKey: string;
  /** Auth type from the manifest — gates the renew CTA to oauth2 only. */
  authType: IntegrationAuthType;
  manifest: IntegrationManifestView;
  /** False when no OAuth client is usable yet — admin must set one up first. */
  canRenew: boolean;
}) {
  const { t } = useTranslation("settings");
  const updateConnection = useUpdateIntegrationConnection();
  const disconnect = useDisconnectIntegrationConnection();
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  const { user } = useAuth();
  const { can } = usePermissions();
  const [editing, setEditing] = useState(false);
  const [draftLabel, setDraftLabel] = useState(connection.label);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteImpact = useConnectionDeleteImpact(confirmDelete ? connection.id : undefined);
  const scopes = summarizeScopes(manifest, authKey, connection.scopes_granted);
  // `label` is the single source of truth (set at creation to the identity or
  // "Connexion N"); render it verbatim.
  const name = connection.label;
  const isShared = connection.shared_with_org === true;
  // The list now returns org-shared connections owned by OTHER members, so
  // every per-row control has to be gated on the same rule the API enforces —
  // otherwise the button renders and the request comes back 403:
  //   - delete  → `DELETE /api/me/connections/:id`, strictly owner-scoped
  //               (`routes/me.ts`), no admin escape hatch by design;
  //   - share   → owner-only, because sharing is the owner's consent
  //               (`routes/integrations.ts`, `shared_with_org` branch);
  //               UNsharing is also open to `integrations:configure`;
  //   - rename  → owner OR org admin (same route, label branch).
  const isOwn = isConnectionOwnedBy(connection, user?.id);
  // Rename, share and reconnect all write the connection, which guards on
  // `integrations:connect` whoever owns it.
  const canConnect = can("integrations:connect");
  const { canRename, canToggleShare, shareLocked } = connectionRowGrants({
    isOwn,
    isShared,
    canConnect,
    canConfigure: can("integrations:configure"),
    locked: !!connection.locked_by,
  });
  // An admin pin or the space default names the row: unsharing and deleting it
  // are refused (409 `connection_pinned`) until it is removed from there.
  const lockKey = connectionLockHintKey(connection.locked_by);
  const lockHint = lockKey ? t(lockKey) : null;
  const startEdit = () => {
    setDraftLabel(connection.label);
    setEditing(true);
  };
  const cancelEdit = () => {
    setEditing(false);
    setDraftLabel(connection.label);
  };
  const submitLabel = () => {
    const next = draftLabel.trim();
    // A run addresses each bound connection by its label, so the label cannot
    // be cleared: an empty field cancels the edit.
    if (next === "" || next === connection.label) {
      setEditing(false);
      return;
    }
    updateConnection.mutate(
      {
        params: { path: { packageId, connectionId: connection.id } },
        body: { label: next },
      },
      { onSuccess: () => setEditing(false) },
    );
  };
  const onDelete = () => {
    if (!orgId || !spaceId) return;
    setConfirmDelete(true);
  };
  return (
    <>
      <TableRow data-testid={`connection-row-${connection.id}`}>
        {/* Account — inline rename */}
        <TableCell>
          {editing ? (
            <div className="flex items-center gap-1">
              <Input
                value={draftLabel}
                onChange={(e) => setDraftLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitLabel();
                  if (e.key === "Escape") cancelEdit();
                }}
                placeholder={t("integration.connection.labelPlaceholder")}
                className="h-7 max-w-xs text-sm"
                autoFocus
                data-testid={`label-input-${connection.id}`}
              />
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
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
                className="size-7"
                onClick={cancelEdit}
                disabled={updateConnection.isPending}
                title={t("integration.connection.labelCancel")}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-1">
              <span className="min-w-0 truncate font-medium">{name}</span>
              {!isOwn && (
                <Badge
                  variant="secondary"
                  className="shrink-0 text-[0.6rem] whitespace-nowrap"
                  data-testid={`connection-owner-${connection.id}`}
                >
                  {connection.owner_name
                    ? t("integration.connection.sharedByOwner", { owner: connection.owner_name })
                    : t("integration.connection.sharedByUnknown")}
                </Badge>
              )}
              {canRename && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  onClick={startEdit}
                  title={t("integration.connection.labelEdit")}
                  data-testid={`label-edit-${connection.id}`}
                >
                  <Pencil className="size-3" />
                </Button>
              )}
            </div>
          )}
          <ConnectionVariablesLine
            variables={connection.variables}
            testId={`connection-variables-${connection.id}`}
          />
        </TableCell>

        {/* Status — connected / needs reconnection (+ renew) + expiry */}
        <TableCell>
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              {connection.needs_reconnection ? (
                <>
                  <ConnectionStatusBadge tone="needsReconnection">
                    {t("integration.auth.needsReconnection")}
                  </ConnectionStatusBadge>
                  {/* Owner-only: the reconnect writes through
                      `persistCredentialBundle` kind `update-owned`, whose WHERE
                      carries the actor identity — a non-owner reconnect 404s.
                      Only the owner can re-authenticate their own credential,
                      so others see the state without a dead CTA. */}
                  {isOwn && canConnect && canRenew && authType === "oauth2" && (
                    <InlineConnectButton
                      packageId={packageId}
                      authKey={authKey}
                      intent="reconnect"
                      // Threading the existing row id is what makes the OAuth
                      // callback UPDATE-in-place rather than INSERT a duplicate
                      // (integration-connections.ts:721 "explicit connectionId
                      // = update; no id = insert").
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
        </TableCell>

        {/* Granted scopes */}
        <TableCell className="max-w-[16rem]">
          {scopes ? (
            // The labels name the grant; the raw values stay one hover away.
            <span
              className="text-muted-foreground block truncate text-[0.65rem]"
              title={connection.scopes_granted.join(" ")}
            >
              {scopes.text ?? t("integration.connection.defaultPermissions")}
            </span>
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          )}
        </TableCell>

        {/* Org-share toggle — sharing is the owner's consent, a governor can only withdraw it */}
        <TableCell>
          {canToggleShare ? (
            <DisabledReasonTooltip reason={shareLocked ? lockHint : null}>
              <label
                className="flex items-center gap-1.5 text-xs"
                title={
                  shareLocked
                    ? undefined
                    : t(
                        isOwn
                          ? "integration.connection.shareWithOrg.help"
                          : "integration.connection.shareWithOrg.unshareHelp",
                      )
                }
              >
                <input
                  type="checkbox"
                  checked={isShared}
                  disabled={updateConnection.isPending || shareLocked}
                  onChange={(e) =>
                    updateConnection.mutate({
                      params: { path: { packageId, connectionId: connection.id } },
                      body: { shared_with_org: e.target.checked },
                    })
                  }
                  data-testid={`share-toggle-${connection.id}`}
                />
                {t("integration.connection.shareWithOrg.label")}
              </label>
            </DisabledReasonTooltip>
          ) : (
            <span className="text-muted-foreground text-xs">
              {isShared ? t("connections.sharedBadge") : "—"}
            </span>
          )}
          {lockHint && (isOwn || canToggleShare) && (
            <p
              className="text-muted-foreground mt-1 max-w-[16rem] text-[0.65rem] whitespace-normal"
              data-testid={`connection-lock-reason-${connection.id}`}
            >
              {lockHint}
            </p>
          )}
        </TableCell>

        {/* Disconnect — owner-only: the endpoint is `/api/me/connections` */}
        <TableCell className="text-right">
          {isOwn ? (
            <DisabledReasonTooltip reason={lockHint}>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                onClick={onDelete}
                disabled={disconnect.isPending || !!lockHint}
                title={lockHint ? undefined : t("integration.connection.delete")}
                data-testid={`connection-delete-${connection.id}`}
              >
                <Trash2 className="text-destructive size-3.5" />
              </Button>
            </DisabledReasonTooltip>
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          )}
        </TableCell>
      </TableRow>
      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t("btn.confirm", { ns: "common" })}
        description={t("integration.connection.deleteConfirm")}
        isPending={disconnect.isPending}
        confirmDisabled={isQueryInFlight(deleteImpact)}
        onConfirm={() =>
          disconnect.mutate(
            { params: { path: { connectionId: connection.id } } },
            { onSuccess: () => setConfirmDelete(false) },
          )
        }
      >
        {confirmDelete && (
          <>
            <ConnectionDeleteImpact impact={deleteImpact} />
            <ConnectionTeardownSteps connectionId={connection.id} />
          </>
        )}
      </ConfirmModal>
    </>
  );
}
