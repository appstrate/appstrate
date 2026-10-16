// SPDX-License-Identifier: Apache-2.0

/**
 * Row controls as components: each owns state or a mutation, and `cell` runs during the table's
 * render (a hook there would be a hook in a loop).
 *
 * What the caller may do is the server's verdict (`allowed_actions`), not re-derived: the list
 * includes org-shared rows owned by OTHER members. Delete and reconnect stay on ownership alone
 * (no admin escape hatch by design). Writes also need `integrations:connect`; a row an admin pin
 * or the space default names refuses unshare/delete (409 `connection_pinned`): controls stay,
 * disabled, with the reason.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { Bot, Pencil, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { DropdownMenuItem, DropdownMenuLabel } from "@appstrate/ui/components/dropdown-menu";
import { InlineEditableLabel } from "../inline-editable-label";
import { ConnectionStatusBadge } from "../integration-connect/connection-status-badge";
import { ConnectionShareEditor } from "../integration-connect/connection-share-editor";
import { ConnectionVariablesLine } from "../integration-connect/connection-variables-line";
import { useHostedConnectPopup } from "../integration-connect/use-hosted-connect-popup";
import { ConnectionDeleteConfirm } from "../integration-connect/connection-delete-confirm";
import { connectionLockHintKey } from "../integration-connect/connection-ownership";
import {
  useRenameIntegrationConnection,
  useConnectionShare,
  useConnectionFutureSharing,
  type IntegrationAuthType,
  type IntegrationConnection,
  useAgentsConsumingIntegration,
  useIntegrationPins,
} from "../../hooks/use-integrations";
import { usePermissions } from "../../hooks/use-permissions";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { useCurrentOrgId } from "../../hooks/use-org";
import { useOrgSpaces } from "../../hooks/use-spaces";
import { useCanReach } from "../../hooks/use-can-reach";
import { packageDetailPath } from "../../lib/package-paths";
import { integrationSettingsHref } from "../../lib/settings-section-href";
import { TableRowActions } from "../table-row-actions";

/** The agents an admin pin binds this connection to; the queries only run for an admin-pin-locked row. */
function usePinningAgents(connection: IntegrationConnection, packageId: string) {
  const pinned = connection.locked_by === "admin_pin";
  const { data: pins } = useIntegrationPins(pinned ? packageId : undefined);
  const { data: agents } = useAgentsConsumingIntegration(pinned ? packageId : undefined);
  if (!pinned || !pins) return [];
  return pins
    .filter((pin) => pin.connection_ids.includes(connection.id))
    .map((pin) => ({
      id: pin.agent_package_id,
      name:
        agents?.find((agent) => agent.agent_package_id === pin.agent_package_id)?.display_name ??
        pin.agent_package_id,
    }));
}

/** Why a locked row refuses unshare/delete: names the pinning agents when known, else the generic sentence. */
function useLockText(
  connection: IntegrationConnection,
  packageId: string,
  isAdmin: boolean,
  lockKey: string | null,
) {
  const { t } = useTranslation("settings");
  const agents = usePinningAgents(connection, packageId);
  if (!lockKey) return { agents, text: null };
  if (agents.length === 0) return { agents, text: t(lockKey) };
  return {
    agents,
    text: [
      t("integration.connection.lock.pinnedTo", { agents: agents.map((a) => a.name).join(", ") }),
      t(
        isAdmin
          ? "integration.connection.lock.removeFromAgents"
          : "integration.connection.lock.askRemoveFromAgents",
        { count: agents.length },
      ),
    ].join(" "),
  };
}

/** What the caller may do to this row: the API's verdict on it (`allowed_actions`). */
function useRowGrants(connection: IntegrationConnection, isAdmin: boolean) {
  const { can } = usePermissions();
  const spaceId = useCurrentSpaceId();
  const actions = connection.allowed_actions ?? [];
  return {
    canConnect: can("integrations:connect"),
    spaceId,
    canRename: actions.includes("rename"),
    canShare: actions.includes("share"),
    canUnshareHere: actions.includes("unshare_here"),
    lockKey: connectionLockHintKey(connection.locked_by, isAdmin),
  };
}

/**
 * The account, renamed in place via `InlineEditableLabel` (started from the row menu; no Edit
 * button). Variables (instance URL) sit under the label: they tell two accounts apart.
 * The label cannot be cleared: a run addresses each bound connection by it.
 */
export function AccountCell({
  connection,
  packageId,
  isAdmin,
  renaming,
  onRenamingChange,
}: {
  connection: IntegrationConnection;
  packageId: string;
  isAdmin: boolean;
  /** The row's « Rename » menu entry puts the name in edit. */
  renaming: boolean;
  onRenamingChange: (renaming: boolean) => void;
}) {
  const { t } = useTranslation("settings");
  const renameConnection = useRenameIntegrationConnection();
  const { canRename } = useRowGrants(connection, isAdmin);

  return (
    <div className="min-w-0">
      <InlineEditableLabel
        value={connection.label}
        editable={canRename}
        editing={renaming}
        onEditingChange={onRenamingChange}
        placeholder={t("integration.connection.labelPlaceholder")}
        testId={`label-edit-${connection.id}`}
        onSave={async (next) => {
          await renameConnection.mutateAsync({
            params: { path: { packageId, connectionId: connection.id } },
            body: { label: next },
          });
        }}
      />
      <ConnectionVariablesLine
        variables={connection.variables}
        testId={`connection-variables-${connection.id}`}
      />
    </div>
  );
}

/** Connected, or needing a reconnection its owner alone can perform. */
export function StatusCell({ connection }: { connection: IntegrationConnection }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <ConnectionStatusBadge needsReconnection={connection.needs_reconnection} />
    </div>
  );
}

/** Sharing is the owner's consent; a governor can only withdraw a colleague's share here. */
export function SharingCell({
  connection,
  packageId,
  isAdmin,
}: {
  connection: IntegrationConnection;
  packageId: string;
  isAdmin: boolean;
}) {
  const shareConnection = useConnectionShare("share", packageId);
  const futureSharing = useConnectionFutureSharing(packageId);
  const unshareConnection = useConnectionShare("unshare", packageId);
  const orgId = useCurrentOrgId();
  const { spaceId, canShare, canUnshareHere, lockKey } = useRowGrants(connection, isAdmin);
  const { text: lockText } = useLockText(connection, packageId, isAdmin, lockKey);
  // Only the owner carries either list.
  const { data: orgSpaces } = useOrgSpaces(canShare ? orgId : null);
  const shareTargets = useMemo(() => {
    const names = new Map((orgSpaces ?? []).map((s) => [s.id, s.name]));
    const shareable = connection.shareable_spaces ?? [];
    const sharedOnly = (connection.shared_space_ids ?? []).filter(
      (id) => !shareable.some((s) => s.id === id),
    );
    return [...shareable, ...sharedOnly.map((id) => ({ id, name: names.get(id) ?? id }))];
  }, [orgSpaces, connection.shareable_spaces, connection.shared_space_ids]);
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5">
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
        lockHint={lockText}
        pending={
          shareConnection.isPending || unshareConnection.isPending || futureSharing.isPending
        }
        onShare={(targetSpaceId) =>
          shareConnection.mutate({ connectionId: connection.id, spaceId: targetSpaceId })
        }
        canShareAll={connection.allowed_actions?.includes("share_all") ?? false}
        shareNewSpaces={connection.share_new_spaces ?? false}
        onFutureSharingChange={(enabled) =>
          futureSharing.mutate({ connectionId: connection.id, enabled })
        }
        onUnshare={(targetSpaceId) =>
          unshareConnection.mutate({ connectionId: connection.id, spaceId: targetSpaceId })
        }
      />
    </div>
  );
}

/** Every deed of the row sits in its « … » menu: rename, reconnect when needed, then delete. */
export function ConnectionActionsCell({
  connection,
  packageId,
  authKey,
  authType,
  canRenew,
  isOwn,
  isAdmin,
  renaming,
  onRename,
}: {
  connection: IntegrationConnection;
  packageId: string;
  authKey: string;
  authType: IntegrationAuthType;
  canRenew: boolean;
  isOwn: boolean;
  isAdmin: boolean;
  renaming: boolean;
  onRename: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const { openPopup, isPending: reconnecting } = useHostedConnectPopup();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { canConnect, canRename, lockKey } = useRowGrants(connection, isAdmin);
  const { text: lockHint, agents: pinningAgents } = useLockText(
    connection,
    packageId,
    isAdmin,
    lockKey,
  );
  const canReach = useCanReach();
  const location = useLocation();
  const canReconnect =
    isOwn && connection.needs_reconnection && canConnect && canRenew && authType === "oauth2";
  return (
    <>
      <TableRowActions
        menuLabel={t("providers.moreActions", { name: connection.label })}
        isPending={reconnecting}
        renaming={renaming}
        actions={[
          {
            id: "rename",
            label: t("btn.rename", { ns: "common" }),
            icon: Pencil,
            onSelect: onRename,
            hidden: !canRename,
            testId: `connection-rename-${connection.id}`,
          },
          {
            id: "reconnect",
            label: t("detail.integrationReconnect", { ns: "agents" }),
            icon: RefreshCw,
            onSelect: () => void openPopup({ packageId, authKey, connectionId: connection.id }),
            hidden: !canReconnect,
            testId: `connection-reconnect-${connection.id}`,
          },
          {
            id: "delete",
            label: t("integration.connection.delete"),
            icon: Trash2,
            onSelect: () => setConfirmDelete(true),
            disabled: !!lockHint,
            destructive: true,
            hidden: !isOwn,
            testId: `connection-delete-${connection.id}`,
          },
        ]}
      >
        {/* In the menu: a disabled item takes no hover. */}
        {isOwn && lockHint && (
          <DropdownMenuLabel className="text-muted-foreground max-w-64 text-xs font-normal">
            {lockHint}
          </DropdownMenuLabel>
        )}
        {(isOwn ? pinningAgents : [])
          .filter((agent) => canReach(packageDetailPath("agent", agent.id)))
          .map((agent) => (
            <DropdownMenuItem key={agent.id} asChild>
              <Link to={packageDetailPath("agent", agent.id)}>
                <Bot />
                {agent.name}
              </Link>
            </DropdownMenuItem>
          ))}
        {isOwn && lockHint && isAdmin && (
          <DropdownMenuItem asChild>
            <Link to={integrationSettingsHref(location.pathname, "access")}>
              <ShieldCheck />
              {t("integration.connection.lock.openAccessRules")}
            </Link>
          </DropdownMenuItem>
        )}
      </TableRowActions>
      <ConnectionDeleteConfirm
        connectionId={connection.id}
        name={connection.label}
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
      />
    </>
  );
}
