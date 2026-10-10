// SPDX-License-Identifier: Apache-2.0

/**
 * The integration detail's two column sets, out of the 1800-line page they are
 * drawn on.
 *
 * Same reason as `org-settings/model-columns.tsx`: a column set is data, and it
 * has to be reachable by `column-tiers.test.tsx` — a set that is not in that
 * test inherits the tier rule without being checked against it. The page itself
 * cannot be imported by the runner (it reaches the package editor and the
 * connect popup through modules bun does not resolve), so the sets live here.
 *
 * Both are the same FAMILY as the models, credentials and proxies tables. A
 * stable provenance value gets its own text column; badges are reserved for
 * row states that benefit from visual emphasis.
 *
 * A cell that needs its own state or its own mutation is a COMPONENT, not a
 * closure: `cell` is called during the table's render, so a hook inside one
 * would be a hook inside a loop. Those components live in
 * `integration-connection-cells.tsx` — the row's controls each own their state
 * now, the rename in the account cell and the confirmation in the actions cell,
 * instead of one row component holding both.
 */

import { useTranslation } from "react-i18next";
import { ArrowUpFromLine, Building2, CircleCheck, Pencil, Trash2 } from "lucide-react";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import type { DataColumn } from "../components/data-table";
import { DefaultCell } from "../components/default-cell";
import { TableRowActions } from "../components/table-row-actions";
import { isConnectionOwnedBy } from "../components/integration-connect/connection-ownership";
import type { ConnectionAuthContext } from "../lib/integration-presentation";
import type {
  IntegrationAuthType,
  IntegrationConnection,
  IntegrationManifestView,
} from "../hooks/use-integrations";
import { ScopeSummaryText } from "../components/integration-connect/scope-summary-text";
import type { ClientRow } from "../lib/integration-clients";
import {
  AccountCell,
  ConnectionActionsCell,
  ScopeCell,
  StatusCell,
} from "./integration-connection-cells";

// ─────────────────────────────────────────────
// OAuth clients
// ─────────────────────────────────────────────

/**
 * The OAuth client column set: which client, at what level, whether this space
 * uses it, and what may be done to it.
 *
 * ONE table for both tiers (`lib/integration-clients.ts` merges the space's and
 * the organisation's lists): a client appears once, and "used here" is the
 * single verdict that matters for a new connection. Use waits for a 36rem
 * table and level for the next tier: on a phone what matters is which clients
 * exist and how to remove one, and on a narrow table which one is in use.
 *
 * What a row offers follows its level: a space's own client can be edited,
 * shared with the organisation or deleted by whoever configures the space; an
 * organisation client only by an org integrations admin; the system's by nobody.
 */
export function useIntegrationClientColumns({
  canUseHere,
  canManageOrg,
  canChooseOrgDefault,
  canPromote,
  pendingClientRef,
  onUseHere,
  onUseForOrg,
  onEdit,
  onPromote,
  onDelete,
}: {
  /** Choosing one only means something when the space can mint with more than one. */
  canUseHere: boolean;
  /** The caller holds `org-integrations:configure`. */
  canManageOrg: boolean;
  /** Same rule for the organisation's own choice. */
  canChooseOrgDefault: boolean;
  /** Moving a space's own client up to the organisation. */
  canPromote: boolean;
  /** The row with a write in flight — only that row shows pending. */
  pendingClientRef: string | null;
  onUseHere: (row: ClientRow) => void;
  onUseForOrg: (row: ClientRow) => void;
  onEdit: (row: ClientRow) => void;
  onPromote: (row: ClientRow) => void;
  onDelete: (row: ClientRow) => void;
}): DataColumn<ClientRow>[] {
  const { t } = useTranslation("settings");

  return [
    {
      id: "client",
      header: t("integration.clients.col.clientId"),
      width: "minmax(200px,2fr)",
      cell: ({ client }) => (
        <span className="text-muted-foreground block truncate text-sm" title={client.client_id}>
          {client.client_id}
        </span>
      ),
    },
    {
      id: "level",
      header: t("integration.clients.col.level"),
      width: "104px",
      tier: 3,
      cell: ({ client, level }) => (
        <span className="text-muted-foreground block truncate text-xs">
          {level === "system"
            ? t("source.builtIn")
            : level === "org"
              ? t("source.org")
              : client.auto_provisioned
                ? t("source.autoProvisioned")
                : t("source.space")}
        </span>
      ),
    },
    {
      id: "use",
      header: t("integration.clients.col.use"),
      width: "168px",
      tier: 2,
      cell: (row) =>
        row.usedHere ? (
          <DefaultCell
            isDefault
            defaultLabel={t("integration.clients.usedHere")}
            setLabel={t("integration.clients.useHere")}
            canSetDefault={false}
            onSetDefault={() => onUseHere(row)}
            testId={`client-used-here-${row.client.client_ref}`}
          />
        ) : row.orgDefault ? (
          <span className="text-muted-foreground block truncate text-xs">
            {t("integration.clients.orgDefault")}
          </span>
        ) : null,
    },
    {
      id: "actions",
      header: "",
      width: "80px",
      align: "end",
      cell: (row) => {
        const { client, level } = row;
        // A system client is the platform's, and an auto-provisioned one was
        // minted by the server at connect time — neither has settings an
        // admin could edit here. Deleting the auto-provisioned one is
        // allowed: it re-triggers registration.
        const ownLevel = level === "space" || (level === "org" && canManageOrg);
        const editable = ownLevel && !client.auto_provisioned;
        const promotable = level === "space" && !client.auto_provisioned && canPromote;
        const useHere = canUseHere && row.inSpaceList && !row.usedHere;
        const useForOrg = canChooseOrgDefault && row.inOrgList && !row.orgDefault;
        if (!ownLevel && !useHere && !useForOrg) return null;
        return (
          <TableRowActions
            menuLabel={t("integration.oauthClient.moreActions", { name: client.client_id })}
            isPending={pendingClientRef === client.client_ref}
            pendingLabel={t("common:loading")}
          >
            {useHere && (
              <DropdownMenuItem
                onSelect={() => onUseHere(row)}
                disabled={pendingClientRef !== null}
                data-testid={`set-default-client-${client.client_ref}`}
              >
                <CircleCheck />
                {t("integration.clients.useHere")}
              </DropdownMenuItem>
            )}
            {useForOrg && (
              <DropdownMenuItem
                onSelect={() => onUseForOrg(row)}
                disabled={pendingClientRef !== null}
                data-testid={`org-set-default-client-${client.client_ref}`}
              >
                <Building2 />
                {t("integration.clients.useForOrg")}
              </DropdownMenuItem>
            )}
            {promotable && (
              <DropdownMenuItem
                onSelect={() => onPromote(row)}
                data-testid={`oauth-client-promote-${client.client_ref}`}
              >
                <ArrowUpFromLine />
                {t("integration.clients.promote.action")}
              </DropdownMenuItem>
            )}
            {editable && (
              <DropdownMenuItem
                onSelect={() => onEdit(row)}
                data-testid={`oauth-client-edit-${client.client_ref}`}
              >
                <Pencil />
                {t("integration.oauthClient.btnEdit")}
              </DropdownMenuItem>
            )}
            {ownLevel && (
              <DropdownMenuItem
                onSelect={() => onDelete(row)}
                disabled={pendingClientRef === client.client_ref}
                data-testid={`oauth-client-delete-${client.client_ref}`}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 />
                {t("integration.oauthClient.btnDelete")}
              </DropdownMenuItem>
            )}
          </TableRowActions>
        );
      },
    },
  ];
}

// ─────────────────────────────────────────────
// Connected accounts
// ─────────────────────────────────────────────

/**
 * The connected-account column set.
 *
 * Ownership decides most of this table, which is why it is an argument rather
 * than a hook call: the list returns org-shared rows owned by OTHER members,
 * and delete, share and reconnect are all owner-only server-side. A control
 * drawn for a row the caller does not own is a button that answers 403.
 *
 * Tier one is the account and its action end. Status and the scope with
 * its share editor wait for 36rem; the owner, the granted scopes and the expiry wait for 56rem
 * because they are the longest and least often read facts.
 */
export function useConnectionColumns({
  packageId,
  authKey,
  authType,
  canRenew,
  manifest,
  userId,
  isAdmin,
  authForConnection,
}: {
  packageId: string;
  authKey: string;
  /** From the manifest — the renew CTA is oauth2 only. */
  authType: IntegrationAuthType;
  /** False when no OAuth client is usable yet: renewing would 403. */
  canRenew: boolean;
  /** Names the granted scopes by each auth's `scope_catalog`. */
  manifest: IntegrationManifestView;
  userId: string | undefined;
  isAdmin: boolean;
  /** Mixed-method tables resolve renew against the row's own authentication. */
  authForConnection?: (connection: IntegrationConnection) => ConnectionAuthContext;
}): DataColumn<IntegrationConnection>[] {
  const { t } = useTranslation("settings");
  return [
    {
      id: "account",
      header: t("integration.connection.col.account"),
      width: "minmax(124px,1.5fr)",
      cell: (c) => <AccountCell connection={c} packageId={packageId} isAdmin={isAdmin} />,
    },
    {
      id: "status",
      header: t("integration.connection.col.status"),
      width: "minmax(128px,1fr)",
      tier: 2,
      cell: (c) => <StatusCell connection={c} />,
    },
    {
      id: "owner",
      header: t("integration.connection.col.owner"),
      width: "minmax(80px,1fr)",
      tier: 3,
      cell: (c) => (
        <span className="text-muted-foreground block truncate text-xs">
          {c.owner_name ?? t("integration.connection.ownerUnknown")}
        </span>
      ),
    },
    {
      id: "scopes",
      header: t("integration.connection.col.scopes"),
      width: "minmax(140px,1.5fr)",
      tier: 3,
      cell: (c) =>
        c.scopes_granted.length > 0 ? (
          <ScopeSummaryText
            manifest={manifest}
            authKey={authForConnection?.(c).authKey ?? authKey}
            scopes={c.scopes_granted}
            className="text-muted-foreground block truncate text-[0.65rem]"
          />
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        ),
    },
    {
      id: "expires",
      header: t("integration.connection.col.expires"),
      width: "100px",
      tier: 3,
      cell: (c) => (
        <span className="text-muted-foreground block truncate text-xs">
          {c.expiresAt ? new Date(c.expiresAt).toLocaleDateString() : "—"}
        </span>
      ),
    },
    {
      id: "shared",
      header: t("integration.connection.col.shared"),
      width: "minmax(112px,1fr)",
      tier: 2,
      cell: (c) => <ScopeCell connection={c} packageId={packageId} isAdmin={isAdmin} />,
    },
    {
      id: "actions",
      header: "",
      width: "80px",
      align: "end",
      cell: (c) => (
        <ConnectionActionsCell
          connection={c}
          packageId={packageId}
          {...(authForConnection?.(c) ?? { authKey, authType, canRenew })}
          isOwn={isConnectionOwnedBy(c, userId)}
          isAdmin={isAdmin}
        />
      ),
    },
  ];
}
