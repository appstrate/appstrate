// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { CopyBlock } from "../copy-block";
import {
  useIntegrationClients,
  useIntegrationDetail,
  type IntegrationAuthStatus,
  type IntegrationManifestAuth,
} from "../../hooks/use-integrations";
import { ClientsTable } from "./clients-table";

// ─────────────────────────────────────────────
// Configuration tab — per-auth metadata + OAuth clients
// ─────────────────────────────────────────────

/**
 * The redirect URI an admin registers at the provider, once per auth, under
 * the clients table.
 */
function AuthTechnicalSettings({ packageId, authKey }: { packageId: string; authKey: string }) {
  const { t } = useTranslation("settings");
  // Same query keys the table above holds: React Query dedupes, no request.
  const { data: clients } = useIntegrationClients("space", packageId, authKey);
  const { data: detail } = useIntegrationDetail(packageId);
  // What connect will ACTUALLY send. A registered client may carry its own
  // `redirect_uri`, and `OAuth2Strategy.begin` prefers it over the platform
  // callback (`clientRedirectUri ?? redirectUri`) — so showing the platform
  // value unconditionally would hand the admin the wrong string to register in
  // exactly the setup this display exists to get right. New connections always
  // use the space's default client (its own or the org's it inherits), so that
  // client's override is the one that decides.
  const redirectUri =
    clients?.find((c) => c.is_default)?.redirect_uri || detail?.platform_redirect_uri;
  if (!redirectUri) return null;
  return (
    <section className="mt-8">
      <h4 className="mb-4 text-sm font-medium">{t("integration.presentation.technicalDetails")}</h4>
      {redirectUri && (
        <div className="mb-4 space-y-2">
          <p className="text-muted-foreground text-sm">
            {t("integration.oauthClient.platformRedirectUri")}
          </p>
          <CopyBlock value={redirectUri} testId={`platform-redirect-uri-${authKey}`} />
        </div>
      )}
    </section>
  );
}

/**
 * Per-auth admin configuration: what the auth is for, the OAuth clients table
 * (one table for the space's, the organisation's and the system's clients) and
 * the redirect URI to register at the provider.
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
  const isOAuth = status.type === "oauth2";

  return (
    <section data-testid={`auth-config-${status.auth_key}`}>
      <p className="text-muted-foreground mb-5 text-sm">
        {t(
          isOAuth
            ? "integration.presentation.oauthDescription"
            : "integration.presentation.credentialsDescription",
        )}
      </p>
      {isOAuth && (
        <ClientsTable
          packageId={packageId}
          authKey={status.auth_key}
          authDecl={authDecl}
          autoProvisioned={status.client_auto_provisioned}
        />
      )}
      {isOAuth && <AuthTechnicalSettings packageId={packageId} authKey={status.auth_key} />}
    </section>
  );
}
