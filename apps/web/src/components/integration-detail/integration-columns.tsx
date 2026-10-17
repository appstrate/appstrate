// SPDX-License-Identifier: Apache-2.0

/**
 * The column sets of the integration detail's two tables (`connections-table.tsx`,
 * `clients-table.tsx`).
 *
 * A column set is data, beside its tables.
 *
 * Both are the same FAMILY as the models, credentials and proxies tables. A
 * stable provenance value gets its own text column; badges are reserved for
 * row states that benefit from visual emphasis.
 *
 * A cell that needs its own state or its own mutation is a COMPONENT, not a
 * closure: `cell` is called during the table's render, so a hook inside one
 * would be a hook inside a loop. Those components live in
 * `integration-connection-cells.tsx` — the row's controls each own their state,
 * the rename in the account cell and the confirmation in the actions cell,
 * rather than one row component holding both.
 */

import { Badge } from "@appstrate/ui/components/badge";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpFromLine, Building2, CircleCheck, Pencil, Trash2 } from "lucide-react";
import type { DataColumn } from "../data-table";
import { TableRowActions } from "../table-row-actions";
import { rowActionsColumn } from "../row-actions-column";
import { CellDate, CellEmpty, CellText } from "../table-cells";
import { isConnectionOwnedBy } from "../integration-connect/connection-ownership";
import type { ConnectionAuthContext } from "../../lib/integration-presentation";
import type { IntegrationConnection, IntegrationManifestView } from "../../hooks/use-integrations";
import { ConnectionScopeBadge } from "../integration-connect/connection-scope-badge";
import { ScopeSummaryText } from "../integration-connect/scope-summary-text";
import type { ClientRow } from "../../lib/integration-clients";
import {
  AccountCell,
  ConnectionActionsCell,
  SharingCell,
  StatusCell,
} from "./integration-connection-cells";

// ─────────────────────────────────────────────
// OAuth clients
// ─────────────────────────────────────────────

/** The label key of a client's level; an auto-provisioned space client is told apart. */
export function clientLevelKey({ client, level }: ClientRow) {
  if (level === "system") return "source.builtIn";
  if (level === "org") return "source.org";
  return client.auto_provisioned ? "source.autoProvisioned" : "source.space";
}

/**
 * What the caller may do to a client: a space's own one is the space admin's, an organization
 * one the org integrations admin's, the system's nobody's. A system client is the platform's and
 * an auto-provisioned one was minted by the server at connect time: neither has settings an admin
 * could edit (the auto-provisioned one may be deleted, which re-triggers registration).
 */
export function clientDeeds({ client, level }: ClientRow, canManageOrg: boolean) {
  const ownLevel = level === "space" || (level === "org" && canManageOrg);
  return { ownLevel, editable: ownLevel && !client.auto_provisioned };
}

/**
 * The OAuth client column set: which client, at what level, whether this space
 * uses it, and what may be done to it.
 *
 * ONE table for both tiers (`lib/integration-clients.ts` merges the space's and
 * the organization's lists): a client appears once, and "used here" is the
 * single verdict that matters for a new connection. Use waits for a 36rem
 * table and level for the next tier: on a phone what matters is which clients
 * exist and how to remove one, and on a narrow table which one is in use.
 *
 * What a row offers follows its level: a space's own client can be edited,
 * shared with the organization or deleted by whoever configures the space; an
 * organization client only by an org integrations admin; the system's by nobody.
 */
export function useIntegrationClientColumns({
  canUseHere,
  canManageOrg,
  canChooseOrgDefault,
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
  /** Same rule for the organization's own choice. */
  canChooseOrgDefault: boolean;
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
      header: t("oauthClients.clientIdColumn"),
      width: 200,
      elastic: true,
      cell: ({ client }) => (
        <CellText title={client.client_id} className="text-sm">
          {client.client_id}
        </CellText>
      ),
    },
    {
      id: "level",
      header: t("integration.clients.col.level"),
      width: 104,
      tier: 3,
      cell: (row) => <CellText>{t(clientLevelKey(row))}</CellText>,
    },
    {
      id: "use",
      header: t("integration.clients.col.use"),
      width: 168,
      tier: 2,
      cell: (row) =>
        row.usedHere ? (
          <Badge variant="success">{t("integration.clients.usedHere")}</Badge>
        ) : row.orgDefault ? (
          <CellText>{t("integration.clients.orgDefault")}</CellText>
        ) : null,
    },
    rowActionsColumn((row) => {
      const { client, level } = row;
      const { ownLevel, editable } = clientDeeds(row, canManageOrg);
      const promotable = level === "space" && !client.auto_provisioned && canManageOrg;
      const useHere = canUseHere && row.inSpaceList && !row.usedHere;
      const useForOrg = canChooseOrgDefault && row.inOrgList && !row.orgDefault;
      return (
        <TableRowActions
          menuLabel={t("providers.moreActions", { name: client.client_id })}
          isPending={pendingClientRef === client.client_ref}
          actions={[
            {
              id: "use-here",
              label: t("integration.clients.useHere"),
              icon: CircleCheck,
              onSelect: () => onUseHere(row),
              disabled: pendingClientRef !== null,
              hidden: !useHere,
              testId: `set-default-client-${client.client_ref}`,
            },
            {
              id: "use-for-org",
              label: t("integration.clients.useForOrg"),
              icon: Building2,
              onSelect: () => onUseForOrg(row),
              disabled: pendingClientRef !== null,
              hidden: !useForOrg,
              testId: `org-set-default-client-${client.client_ref}`,
            },
            {
              id: "promote",
              label: t("integration.clients.promote.action"),
              icon: ArrowUpFromLine,
              onSelect: () => onPromote(row),
              hidden: !promotable,
              testId: `oauth-client-promote-${client.client_ref}`,
            },
            {
              id: "edit",
              label: t("integration.oauthClient.btnEdit"),
              icon: Pencil,
              onSelect: () => onEdit(row),
              hidden: !editable,
              testId: `oauth-client-edit-${client.client_ref}`,
            },
            {
              id: "delete",
              label: t("integration.oauthClient.btnDelete"),
              icon: Trash2,
              onSelect: () => onDelete(row),
              disabled: pendingClientRef === client.client_ref,
              destructive: true,
              hidden: !ownLevel,
              testId: `oauth-client-delete-${client.client_ref}`,
            },
          ]}
        />
      );
    }),
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
 * its share editor wait for 36rem; the method, the owner, the granted
 * scopes and the expiry wait for 56rem because they are the longest and least
 * often read facts. The floors are written so that the whole set, method
 * included, holds in 56rem and a 1440px page needs no
 * sideways scroll.
 */
export function useConnectionColumns({
  packageId,
  manifest,
  userId,
  isAdmin,
  authForConnection,
  methodLabel,
}: {
  packageId: string;
  /** Names the granted scopes by each auth's `scope_catalog`. */
  manifest: IntegrationManifestView;
  userId: string | undefined;
  isAdmin: boolean;
  /** The row's own authentication: renew and the scope names resolve against it. */
  authForConnection: (connection: IntegrationConnection) => ConnectionAuthContext;
  /** Names each row's authentication: the table mixes every method of the integration. */
  methodLabel: (connection: IntegrationConnection) => string;
}): DataColumn<IntegrationConnection>[] {
  const { t } = useTranslation("settings");
  // The row whose name is in edit: « Rename » is in one column, the name in another.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  return [
    {
      id: "account",
      header: t("preferences.sectionAccount"),
      width: 100,
      elastic: true,
      cell: (c) => (
        <AccountCell
          connection={c}
          packageId={packageId}
          isAdmin={isAdmin}
          renaming={renamingId === c.id}
          onRenamingChange={(renaming) => setRenamingId(renaming ? c.id : null)}
        />
      ),
    },
    {
      id: "method",
      header: t("integration.presentation.method"),
      width: 84,
      elastic: true,
      tier: 3,
      cell: (c) => <CellText title={methodLabel(c)}>{methodLabel(c)}</CellText>,
    },
    {
      id: "status",
      header: t("proxies.col.status"),
      width: 104,
      elastic: true,
      tier: 2,
      cell: (c) => <StatusCell connection={c} />,
    },
    {
      id: "owner",
      header: t("integration.connection.col.owner"),
      width: 88,
      elastic: true,
      tier: 3,
      cell: (c) => {
        const owner = c.owner_name ?? t("integration.connection.ownerUnknown");
        return <CellText title={owner}>{owner}</CellText>;
      },
    },
    {
      id: "scopes",
      header: t("roles.permissionsLabel"),
      width: 80,
      elastic: true,
      tier: 3,
      cell: (c) =>
        c.scopes_granted.length > 0 ? (
          <ScopeSummaryText
            manifest={manifest}
            authKey={authForConnection(c).authKey}
            scopes={c.scopes_granted}
            className="text-muted-foreground block truncate text-[0.65rem]"
          />
        ) : (
          <CellEmpty />
        ),
    },
    {
      id: "expires",
      header: t("apiKeys.expirationColumn"),
      width: 84,
      tier: 3,
      align: "end",
      cell: (c) => <CellDate value={c.expiresAt} granularity="date" />,
    },
    {
      id: "usage",
      header: t("integration.connection.col.usage"),
      width: 184,
      tier: 2,
      cell: (c) => <ConnectionScopeBadge scope={c.scope} testId={`connection-scope-${c.id}`} />,
    },
    {
      id: "shared",
      header: t("integration.connection.col.shared"),
      width: 168,
      // Share menus: the column scrolls into reach rather than waiting for room.
      control: true,
      cell: (c) => <SharingCell connection={c} packageId={packageId} isAdmin={isAdmin} />,
    },
    rowActionsColumn((c) => (
      <ConnectionActionsCell
        connection={c}
        packageId={packageId}
        {...authForConnection(c)}
        isOwn={isConnectionOwnedBy(c, userId)}
        isAdmin={isAdmin}
        renaming={renamingId === c.id}
        onRename={() => setRenamingId(c.id)}
      />
    )),
  ];
}
