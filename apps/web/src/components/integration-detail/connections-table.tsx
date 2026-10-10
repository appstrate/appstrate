// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
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
  isConnectionOwnedBy,
} from "../integration-connect/connection-ownership";
import { ConnectionStatusBadge } from "../integration-connect/connection-status-badge";
import { ConnectionScopeBadge } from "../integration-connect/connection-scope-badge";
import { ConnectionShareEditor } from "../integration-connect/connection-share-editor";
import { ScopeSummaryText } from "../integration-connect/scope-summary-text";
import { isQueryInFlight } from "../../lib/query-state";
import { usePermissions } from "../../hooks/use-permissions";
import { useOrgSpaces } from "../../hooks/use-spaces";
import {
  useRenameIntegrationConnection,
  useConnectionShare,
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
 * scope and the spaces it is shared into, and a disconnect action.
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
  const renameConnection = useRenameIntegrationConnection();
  const shareConnection = useConnectionShare("share", packageId);
  const unshareConnection = useConnectionShare("unshare", packageId);
  const disconnect = useDisconnectIntegrationConnection();
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  const { user } = useAuth();
  const { can } = usePermissions();
  const [editing, setEditing] = useState(false);
  const [draftLabel, setDraftLabel] = useState(connection.label);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteImpact = useConnectionDeleteImpact(confirmDelete ? connection.id : undefined);
  // `label` is the single source of truth (set at creation to the identity or
  // "Connexion N"); render it verbatim.
  const name = connection.label;
  // The list holds connections other members share into the space: every write control is gated
  // on the row's `allowed_actions`, which the API computes. Delete stays on ownership alone
  // (`DELETE /api/me/connections/:id` has no admin escape hatch by design).
  const isOwn = isConnectionOwnedBy(connection, user?.id);
  const actions = connection.allowed_actions ?? [];
  const canRename = actions.includes("rename");
  const canShare = actions.includes("share");
  const canUnshareHere = actions.includes("unshare_here");
  // Reconnect writes the connection, which guards on `integrations:connect` whoever owns it.
  const canConnect = can("integrations:connect");
  // Share targets: the spaces the owner may share into, plus those it is already shared into
  // (named by the org's spaces). Only the owner carries either list.
  const { data: orgSpaces } = useOrgSpaces(canShare ? orgId : null);
  const shareTargets = useMemo(() => {
    const names = new Map((orgSpaces ?? []).map((s) => [s.id, s.name]));
    const shareable = connection.shareable_spaces ?? [];
    const sharedOnly = (connection.shared_space_ids ?? []).filter(
      (id) => !shareable.some((s) => s.id === id),
    );
    return [...shareable, ...sharedOnly.map((id) => ({ id, name: names.get(id) ?? id }))];
  }, [orgSpaces, connection.shareable_spaces, connection.shared_space_ids]);
  // A pin or default names the row (in any space, for its owner): delete answers 409.
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
    renameConnection.mutate(
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
                disabled={renameConnection.isPending}
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
                disabled={renameConnection.isPending}
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
                      // Threading the existing row id is what makes the OAuth
                      // callback UPDATE-in-place rather than INSERT a duplicate
                      // (integration-connections.ts:721 "explicit connectionId
                      // = update; no id = insert").
                      connectionId={connection.id}
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
          {connection.scopes_granted.length > 0 ? (
            <ScopeSummaryText
              manifest={manifest}
              authKey={authKey}
              scopes={connection.scopes_granted}
              className="text-muted-foreground block truncate text-[0.65rem]"
            />
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          )}
        </TableCell>

        {/* Scope + share targets — sharing is the owner's consent, a governor can only withdraw it */}
        <TableCell>
          <div className="flex flex-col items-start gap-1.5">
            <ConnectionScopeBadge
              scope={connection.scope}
              testId={`connection-scope-${connection.id}`}
            />
            <ConnectionShareEditor
              connectionId={connection.id}
              scope={connection.scope}
              rowSpaceId={connection.spaceId}
              hereSpaceId={spaceId}
              targets={shareTargets}
              sharedSpaceIds={connection.shared_space_ids ?? []}
              sharedHere={connection.shared_here}
              canShare={canShare}
              canUnshareHere={canUnshareHere}
              lockHint={lockHint}
              pending={shareConnection.isPending || unshareConnection.isPending}
              onShare={(targetSpaceId) =>
                shareConnection.mutate({ connectionId: connection.id, spaceId: targetSpaceId })
              }
              onUnshare={(targetSpaceId) =>
                unshareConnection.mutate({ connectionId: connection.id, spaceId: targetSpaceId })
              }
            />
          </div>
          {lockHint && (isOwn || canUnshareHere) && (
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
