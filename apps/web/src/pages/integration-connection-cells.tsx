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
 * What the caller may do to a row is the server's verdict, read from the row's `allowed_actions`
 * (rename, share, unshare here) rather than re-derived: the list returns org-shared rows owned by
 * OTHER members, and a control drawn on a row the caller may not touch is a button that answers
 * 403. Delete and reconnect stay on ownership alone (`DELETE /api/me/connections/:id` has no admin
 * escape hatch by design). Every write also guards on `integrations:connect`, whoever owns the
 * row, and a row an admin pin or the space default names refuses an unshare or a delete (409
 * `connection_pinned`): those controls stay, disabled, with the reason on them.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Bot, ShieldCheck, Trash2 } from "lucide-react";
import { DropdownMenuItem, DropdownMenuLabel } from "@appstrate/ui/components/dropdown-menu";
import { ConfirmModal } from "../components/confirm-modal";
import { InlineEditableLabel } from "../components/inline-editable-label";
import { ConnectionStatusBadge } from "../components/integration-connect/connection-status-badge";
import { ConnectionScopeBadge } from "../components/integration-connect/connection-scope-badge";
import { ConnectionShareEditor } from "../components/integration-connect/connection-share-editor";
import { ConnectionVariablesLine } from "../components/integration-connect/connection-variables-line";
import { InlineConnectButton } from "../components/integration-connect/inline-connect-button";
import { ConnectionDeleteImpact } from "../components/integration-connect/connection-delete-impact";
import { ConnectionTeardownSteps } from "../components/integration-connect/connection-teardown-steps";
import { connectionLockHintKey } from "../components/integration-connect/connection-ownership";
import {
  useRenameIntegrationConnection,
  useConnectionShare,
  type IntegrationAuthType,
  type IntegrationConnection,
  useAgentsConsumingIntegration,
  useIntegrationPins,
} from "../hooks/use-integrations";
import {
  useConnectionDeleteImpact,
  useDisconnectIntegrationConnection,
} from "../hooks/use-me-connections";
import { isQueryInFlight } from "../lib/query-state";
import { usePermissions } from "../hooks/use-permissions";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { useCurrentOrgId } from "../hooks/use-org";
import { useOrgSpaces } from "../hooks/use-spaces";
import { useCanReach } from "../hooks/use-can-reach";
import { packageDetailPath } from "../lib/package-paths";
import { TableRowActions } from "../components/table-row-actions";

/**
 * The agents an admin pin binds this connection to, named so a locked row says WHICH
 * agents hold it. The pins list is readable with `integrations:read`, like this page;
 * the query only runs for a row an admin pin locks.
 */
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

/**
 * Why a locked row refuses an unshare or delete, in words: for an admin pin, the agents
 * that hold it when they are known, else the generic sentence.
 */
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
 * The account, renamed in place.
 *
 * Renaming is the owner's, or a governor's on a row of this space (`allowed_actions`
 * says which), while sharing and deleting are strictly the owner's. A
 * connection's variables (its instance URL) sit under the label: they are what
 * tells two accounts of one integration apart.
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
  isAdmin,
}: {
  connection: IntegrationConnection;
  packageId: string;
  isAdmin: boolean;
}) {
  const { t } = useTranslation("settings");
  const renameConnection = useRenameIntegrationConnection();
  const { canRename } = useRowGrants(connection, isAdmin);

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
 * Where the connection is usable, and the spaces it is shared into.
 *
 * Its scope is the scope of the OAuth client that minted it, so it is a fact
 * (the badge), not a setting. Sharing is the owner's consent: an org-wide row is
 * shared into any space the owner reaches, a space-confined one into its own
 * space alone; a governor of this space can only withdraw a colleague's share
 * here, and a row an admin pin or the space default names refuses that (409).
 */
export function ScopeCell({
  connection,
  packageId,
  isAdmin,
}: {
  connection: IntegrationConnection;
  packageId: string;
  isAdmin: boolean;
}) {
  const shareConnection = useConnectionShare("share", packageId);
  const unshareConnection = useConnectionShare("unshare", packageId);
  const orgId = useCurrentOrgId();
  const { spaceId, canShare, canUnshareHere, lockKey } = useRowGrants(connection, isAdmin);
  const { text: lockText } = useLockText(connection, packageId, isAdmin, lockKey);
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
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      <ConnectionScopeBadge scope={connection.scope} testId={`connection-scope-${connection.id}`} />
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
        pending={shareConnection.isPending || unshareConnection.isPending}
        onShare={(targetSpaceId) =>
          shareConnection.mutate({ connectionId: connection.id, spaceId: targetSpaceId })
        }
        onUnshare={(targetSpaceId) =>
          unshareConnection.mutate({ connectionId: connection.id, spaceId: targetSpaceId })
        }
      />
    </div>
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
  // Read only while the confirmation is open; the button waits for it.
  const deleteImpact = useConnectionDeleteImpact(confirmDelete ? connection.id : undefined);
  const { canConnect, lockKey } = useRowGrants(connection, isAdmin);
  const { text: lockHint, agents: pinningAgents } = useLockText(
    connection,
    packageId,
    isAdmin,
    lockKey,
  );
  const canReach = useCanReach();
  if (!isOwn) return <span className="text-muted-foreground text-xs">—</span>;
  // An admin pin or the space default names the row: deleting it is refused
  // until it is removed from there.
  return (
    <>
      <div className="relative z-10 flex items-center justify-end gap-1">
        {connection.needs_reconnection && canConnect && canRenew && authType === "oauth2" && (
          <InlineConnectButton
            packageId={packageId}
            authKey={authKey}
            connectionId={connection.id}
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
          {/* Each agent holding it, one click away for whoever may open it. */}
          {pinningAgents
            .filter((agent) => canReach(packageDetailPath("agent", agent.id)))
            .map((agent) => (
              <DropdownMenuItem key={agent.id} asChild>
                <Link to={packageDetailPath("agent", agent.id)}>
                  <Bot />
                  {agent.name}
                </Link>
              </DropdownMenuItem>
            ))}
          {/* And the way to unlock it, one click away, for whoever may. */}
          {lockHint && isAdmin && (
            <DropdownMenuItem asChild>
              <Link to={{ search: "?integrationSettings=access", hash: "#configuration" }}>
                <ShieldCheck />
                {t("integration.connection.lock.openAccessRules")}
              </Link>
            </DropdownMenuItem>
          )}
        </TableRowActions>
      </div>
      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t("integration.connection.deleteTitle", { name: connection.label })}
        description={t("integration.connection.deleteConfirm")}
        confirmLabel={t("btn.delete", { ns: "common" })}
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
