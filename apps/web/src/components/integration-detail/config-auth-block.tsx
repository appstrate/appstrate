// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { usePermissions } from "../../hooks/use-permissions";
import type { IntegrationAuthStatus, IntegrationManifestAuth } from "../../hooks/use-integrations";
import { AuthHeader } from "./auth-header";
import { ClientsTable } from "./clients-table";

// ─────────────────────────────────────────────
// Configuration tab — per-auth metadata + OAuth clients
// ─────────────────────────────────────────────

/**
 * Per-auth admin configuration: the declared auth metadata (scopes, resource,
 * authorized URIs) plus the OAuth clients table (system + custom) and the
 * registration form to add/edit/delete the org's own (BYO-app) client.
 * Separated from the runtime connections view (see {@link ConnectAuthBlock}).
 */
export function ConfigAuthBlock({
  packageId,
  status,
  authDecl,
}: {
  packageId: string;
  status: IntegrationAuthStatus;
  authDecl: IntegrationManifestAuth;
}) {
  const { t } = useTranslation("settings");
  const { can } = usePermissions();
  const isOAuth = status.type === "oauth2";

  return (
    <div className="bg-card rounded-lg border p-4" data-testid={`auth-config-${status.auth_key}`}>
      <AuthHeader status={status} />

      {/* Scopes / resource (RFC 8707 — `resource` in AFPS §7.3) */}
      {(status.scopes.length > 0 ||
        status.resource ||
        (authDecl.authorized_uris?.length ?? 0) > 0) && (
        <div className="text-muted-foreground mb-3 grid gap-1 text-xs">
          {status.scopes.length > 0 && (
            <p>
              <span className="font-semibold">{t("integration.auth.scopes")}:</span>{" "}
              <span className="font-mono">{status.scopes.join(", ")}</span>
            </p>
          )}
          {status.resource && (
            <p>
              <span className="font-semibold">{t("integration.auth.resource")}:</span>{" "}
              <span className="font-mono">{status.resource}</span>
            </p>
          )}
          {(authDecl.authorized_uris?.length ?? 0) > 0 && (
            <p className="truncate">
              <span className="font-semibold">{t("integration.auth.authorizedUris")}:</span>{" "}
              <span className="font-mono text-[0.7rem]">
                {authDecl.authorized_uris!.slice(0, 3).join(", ")}
                {authDecl.authorized_uris!.length > 3 &&
                  ` (+${authDecl.authorized_uris!.length - 3})`}
              </span>
            </p>
          )}
        </div>
      )}

      {/* OAuth clients (system + org + space) — list, register, edit, delete, default. */}
      {isOAuth && (
        <ClientsTable
          tier="space"
          packageId={packageId}
          authKey={status.auth_key}
          authDecl={authDecl}
          autoProvisioned={status.client_auto_provisioned}
        />
      )}
      {isOAuth && !status.client_auto_provisioned && can("org-integrations:configure") && (
        <ClientsTable
          tier="org"
          packageId={packageId}
          authKey={status.auth_key}
          authDecl={authDecl}
          autoProvisioned={false}
        />
      )}
      {!isOAuth && (
        <p className="text-muted-foreground text-xs">{t("integration.config.noOAuthClient")}</p>
      )}
    </div>
  );
}
