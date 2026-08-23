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
import { RotateCcw, Trash2 } from "lucide-react";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import type { DataColumn } from "../components/data-table";
import { DefaultCell } from "../components/default-cell";
import { TableRowActions } from "../components/table-row-actions";
import { isConnectionOwnedBy } from "../components/integration-connect/connection-label";
import type {
  IntegrationAuthType,
  IntegrationClient,
  IntegrationConnection,
} from "../hooks/use-integrations";
import {
  AccountCell,
  ConnectionActionsCell,
  SharedCell,
  StatusCell,
} from "./integration-connection-cells";

// ─────────────────────────────────────────────
// OAuth clients
// ─────────────────────────────────────────────

/**
 * The OAuth client column set: which client, whether it is the default, and
 * what may be done to it.
 *
 * Four columns. Type and `default` wait for a 36rem table because on a phone what
 * matters is which clients exist and how to remove one; which of them connect
 * picks is a setting you come back for.
 */
export function useIntegrationClientColumns({
  canChooseDefault,
  settingDefaultClientRef,
  deletingClientRef,
  onSetDefault,
  onRotate,
  onDelete,
}: {
  /** Choosing one only means something when more than one client can mint. */
  canChooseDefault: boolean;
  settingDefaultClientRef: string | null;
  /** The delete in flight — only that row shows pending. */
  deletingClientRef: string | null;
  onSetDefault: (client: IntegrationClient) => void;
  onRotate: (client: IntegrationClient) => void;
  onDelete: (client: IntegrationClient) => void;
}): DataColumn<IntegrationClient>[] {
  const { t } = useTranslation("settings");

  return [
    {
      id: "client",
      header: t("integration.clients.col.clientId"),
      width: "minmax(200px,2fr)",
      cell: (client) => (
        <span className="block truncate font-mono text-xs" title={client.client_id}>
          {client.client_id}
        </span>
      ),
    },
    {
      id: "type",
      header: t("integration.clients.col.type"),
      width: "72px",
      tier: 2,
      cell: (client) => (
        <span className="text-muted-foreground block truncate text-xs">
          {client.auto_provisioned
            ? t("source.autoProvisioned")
            : client.source === "built-in"
              ? t("source.builtIn")
              : t("source.custom")}
        </span>
      ),
    },
    {
      id: "default",
      header: t("integration.clients.col.default"),
      width: "132px",
      tier: 2,
      cell: (client) => (
        <DefaultCell
          isDefault={client.is_default}
          defaultLabel={t("integration.clients.default")}
          setLabel={t("integration.clients.setDefault.action")}
          canSetDefault={canChooseDefault}
          disabled={settingDefaultClientRef !== null}
          isPending={settingDefaultClientRef === client.client_ref}
          onSetDefault={() => onSetDefault(client)}
          testId={`set-default-client-${client.client_ref}`}
        />
      ),
    },
    {
      id: "actions",
      header: "",
      width: "80px",
      align: "end",
      cell: (client) => {
        // A system client is the platform's, and an auto-provisioned one was
        // minted by the server at connect time — neither has credentials an
        // admin could rotate here. Deleting the auto-provisioned one is
        // allowed: it re-triggers registration.
        const editable = client.source === "custom" && !client.auto_provisioned;
        const deletable = client.source === "custom";
        if (!editable && !deletable) return null;
        return (
          <TableRowActions
            primary={
              editable
                ? {
                    label: t("integration.oauthClient.btnRotate"),
                    onSelect: () => onRotate(client),
                    icon: RotateCcw,
                  }
                : undefined
            }
            menuLabel={
              deletable
                ? t("integration.oauthClient.moreActions", { name: client.client_id })
                : undefined
            }
            isPending={deletingClientRef === client.client_ref}
            pendingLabel={t("common:loading")}
          >
            {deletable && (
              <DropdownMenuItem
                onSelect={() => onDelete(client)}
                disabled={deletingClientRef === client.client_ref}
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
 * Tier one is the account and its action end. Status, owner and the share
 * toggle wait for 36rem; granted scopes and expiry wait for 56rem because they
 * are the longest and least often read facts.
 */
export function useConnectionColumns({
  packageId,
  authKey,
  authType,
  canRenew,
  userId,
  isAdmin,
}: {
  packageId: string;
  authKey: string;
  /** From the manifest — the renew CTA is oauth2 only. */
  authType: IntegrationAuthType;
  /** False when no OAuth client is usable yet: renewing would 403. */
  canRenew: boolean;
  userId: string | undefined;
  isAdmin: boolean;
}): DataColumn<IntegrationConnection>[] {
  const { t } = useTranslation("settings");
  // Said once rather than in each of the four cells that key off it.
  const owns = (c: IntegrationConnection) => isConnectionOwnedBy(c, userId);

  return [
    {
      id: "account",
      header: t("integration.connection.col.account"),
      width: "minmax(124px,1.5fr)",
      cell: (c) => (
        <AccountCell connection={c} packageId={packageId} isOwn={owns(c)} isAdmin={isAdmin} />
      ),
    },
    {
      id: "status",
      header: t("integration.connection.col.status"),
      width: "minmax(88px,1fr)",
      tier: 2,
      cell: (c) => <StatusCell connection={c} />,
    },
    {
      id: "owner",
      header: t("integration.connection.col.owner"),
      width: "minmax(80px,1fr)",
      tier: 2,
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
          <span
            className="text-muted-foreground truncate font-mono text-[0.65rem]"
            title={c.scopes_granted.join(" ")}
          >
            {c.scopes_granted.join(" ")}
          </span>
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
      width: "64px",
      tier: 2,
      cell: (c) => <SharedCell connection={c} packageId={packageId} isOwn={owns(c)} />,
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
          authKey={authKey}
          authType={authType}
          canRenew={canRenew}
          isOwn={owns(c)}
        />
      ),
    },
  ];
}
