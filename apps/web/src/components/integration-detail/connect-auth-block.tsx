// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useAuth } from "../../hooks/use-auth";
import { usePermissions } from "../../hooks/use-permissions";
import type { IntegrationAuthStatus, IntegrationManifestView } from "../../hooks/use-integrations";
import { InlineConnectButton } from "../integration-connect/inline-connect-button";
import { isConnectionOwnedBy } from "../integration-connect/connection-ownership";
import { isOauthAuthConnectable } from "../integration-connect/connectable-auth-keys";
import { AuthHeader } from "./auth-header";
import { ConnectionsTable } from "./connections-table";
import { ConnectWithScopesButton } from "./connect-scopes-dialog";
import { scopeChoiceFor } from "./connect-scope-choice";

// ─────────────────────────────────────────────
// Connexions tab — per-auth connect CTA + accounts table
// ─────────────────────────────────────────────

/**
 * Per-auth connect surface: the "+ Ajouter" CTA (admin) — which always connects
 * via the resolved default client (no per-connect picker) — and the table of
 * connected accounts with rename/share/reconnect/disconnect. Runtime view — the
 * OAuth client setup lives in the Configuration tab (see {@link ConfigAuthBlock}).
 *
 * On an oauth2 auth with a `scope_catalog`, "+ Ajouter" first asks which scopes
 * to request on top of the `default_scopes` baseline, optionally ticked from an
 * agent of the space ({@link ConnectWithScopesButton}). Otherwise it connects
 * with the baseline alone.
 */
export function ConnectAuthBlock({
  packageId,
  status,
  manifest,
  personalConnectionsBlocked,
}: {
  packageId: string;
  status: IntegrationAuthStatus;
  manifest: IntegrationManifestView;
  /** The space's `block_user_connections` gate — `integrations:configure` is exempt, as on the server. */
  personalConnectionsBlocked: boolean;
}) {
  const { t } = useTranslation("settings");
  const { user } = useAuth();
  const { can } = usePermissions();
  const canConfigure = can("integrations:configure");
  const isOAuth = status.type === "oauth2";
  const scopeChoice = scopeChoiceFor(manifest.auths?.[status.auth_key]);
  // Connectable when a client is usable: org-registered, shared system client,
  // or auto-provisioned at connect time (remote MCP CIMD/DCR). Shared gate.
  const clientMissing = isOAuth && !isOauthAuthConnectable(status);
  // `status.connections` is the own ∪ org-shared union, but "force the IdP's
  // account chooser" is about the CALLER's own accounts — it exists so a second
  // connect can't silently re-pick the account already signed in on this
  // browser. Someone else's shared connection says nothing about that.
  const ownConnectionCount = status.connections.filter((c) =>
    isConnectionOwnedBy(c, user?.id),
  ).length;

  return (
    <div className="bg-card rounded-lg border p-4" data-testid={`auth-section-${status.auth_key}`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <AuthHeader status={status} />
        {/* Connect CTA / locked state. A missing oauth2 client blocks connecting:
            admins are pointed at the Configuration tab, members get a hint. */}
        {clientMissing ? (
          <p
            className="text-muted-foreground text-xs"
            data-testid={`no-oauth-client-hint-${status.auth_key}`}
          >
            {canConfigure
              ? t("integration.auth.noClientHintAdmin")
              : t("integration.auth.noClientHint")}
          </p>
        ) : !can("integrations:connect") ? null : personalConnectionsBlocked && !canConfigure ? (
          // The server answers 403 `connection_blocked_by_admin`: say why here
          // instead of offering a button that can only fail.
          <p
            className="text-muted-foreground text-xs"
            data-testid={`connections-blocked-hint-${status.auth_key}`}
          >
            {t("integration.auth.blockedByAdminHint")}
          </p>
        ) : scopeChoice ? (
          <ConnectWithScopesButton
            packageId={packageId}
            authKey={status.auth_key}
            manifest={manifest}
            choice={scopeChoice}
            label={t("integration.auth.addAccount")}
            forceAccountSelect={ownConnectionCount > 0}
          />
        ) : (
          <InlineConnectButton
            packageId={packageId}
            authKey={status.auth_key}
            intent="connect"
            label={t("integration.auth.addAccount")}
            forceAccountSelect={ownConnectionCount > 0}
            lockToAuthKey
          />
        )}
      </div>

      <ConnectionsTable
        packageId={packageId}
        authKey={status.auth_key}
        authType={status.type}
        connections={status.connections}
        // Renew via OAuth needs a usable client; when none is available the
        // connect CTA is already hidden, so gate the per-row renew button the
        // same way to avoid a guaranteed 403.
        canRenew={isOAuth && !clientMissing}
      />
    </div>
  );
}
