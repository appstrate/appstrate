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
 * Both are the same FAMILY as the models, credentials and proxies tables: a
 * system+DB list with `SourceBadge` for provenance and `DefaultCell` for the
 * one row that is the default. So the provenance badge sits WITH the row's
 * identity here too, rather than in a column of its own — four sibling tables
 * reading the same way is worth more than a column that only repeats what a
 * badge already says.
 *
 * A cell that needs its own state or its own mutation is a COMPONENT, not a
 * closure: `cell` is called during the table's render, so a hook inside one
 * would be a hook inside a loop. Those components live in
 * `integration-connection-cells.tsx` — the row's controls each own their state
 * now, the rename in the account cell and the confirmation in the actions cell,
 * instead of one row component holding both.
 */

import { useTranslation } from "react-i18next";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import type { DataColumn } from "../components/data-table";
import { DefaultCell } from "../components/default-cell";
import { SourceBadge } from "../components/source-badge";
import { isConnectionOwnedBy } from "../components/integration-connect/connection-label";
import type {
  IntegrationAuthType,
  IntegrationClient,
  IntegrationConnection,
} from "../hooks/use-integrations";
import {
  AccountCell,
  DisconnectCell,
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
 * Three columns. `default` waits for a 36rem table because on a phone what
 * matters is which clients exist and how to remove one; which of them connect
 * picks is a setting you come back for.
 */
export function useIntegrationClientColumns({
  canChooseDefault,
  isSettingDefault,
  isDeleting,
  onSetDefault,
  onRotate,
  onDelete,
}: {
  /** Choosing one only means something when more than one client can mint. */
  canChooseDefault: boolean;
  isSettingDefault: boolean;
  /** A delete in flight — the row's button stops re-opening the confirmation. */
  isDeleting: boolean;
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
        <div className="flex min-w-0 items-center gap-2">
          <SourceBadge source={client.source} autoProvisioned={client.auto_provisioned} />
          <span className="truncate font-mono text-xs" title={client.client_id}>
            {client.client_id}
          </span>
        </div>
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
          disabled={isSettingDefault}
          onSetDefault={() => onSetDefault(client)}
          testId={`set-default-client-${client.client_ref}`}
        />
      ),
    },
    {
      id: "actions",
      header: "",
      width: "72px",
      align: "end",
      cell: (client) => {
        // A system client is the platform's, and an auto-provisioned one was
        // minted by the server at connect time — neither has credentials an
        // admin could rotate here. Deleting the auto-provisioned one is
        // allowed: it re-triggers registration.
        const editable = client.source === "custom" && !client.auto_provisioned;
        const deletable = client.source === "custom";
        return (
          <div className="flex items-center justify-end gap-1">
            {editable && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0"
                onClick={() => onRotate(client)}
                data-testid={`oauth-client-rotate-${client.client_ref}`}
                aria-label={t("integration.oauthClient.btnRotate")}
              >
                <Pencil size={14} />
              </Button>
            )}
            {deletable && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0"
                onClick={() => onDelete(client)}
                disabled={isDeleting}
                data-testid={`oauth-client-delete-${client.client_ref}`}
                aria-label={t("integration.oauthClient.btnDelete")}
              >
                <Trash2 size={14} className="text-destructive" />
              </Button>
            )}
          </div>
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
 * Tier one is the account and its state — a connection you cannot name and
 * whose health you cannot read is not worth a row. The share toggle waits for
 * 36rem and the granted scopes for 56rem: scopes are the longest thing here
 * and the least often read.
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
      width: "minmax(112px,1fr)",
      cell: (c) => (
        <StatusCell
          connection={c}
          packageId={packageId}
          authKey={authKey}
          authType={authType}
          canRenew={canRenew}
          isOwn={owns(c)}
        />
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
      id: "shared",
      header: t("integration.connection.col.shared"),
      width: "88px",
      tier: 2,
      cell: (c) => <SharedCell connection={c} packageId={packageId} isOwn={owns(c)} />,
    },
    {
      id: "actions",
      header: "",
      width: "56px",
      align: "end",
      cell: (c) => <DisconnectCell connection={c} isOwn={owns(c)} />,
    },
  ];
}
