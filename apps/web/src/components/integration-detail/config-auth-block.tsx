// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { CopyBlock } from "../copy-block";
import { SettingValue } from "../settings/setting-row";
import {
  useIntegrationClients,
  useIntegrationDetail,
  type IntegrationAuthStatus,
  type IntegrationManifestAuth,
} from "../../hooks/use-integrations";
import { ClientsTable } from "./clients-table";

/** The redirect URI an admin registers at the provider, once per auth. */
function AuthTechnicalSettings({ packageId, authKey }: { packageId: string; authKey: string }) {
  const { t } = useTranslation("settings");
  const { data: clients, isLoading: clientsLoading } = useIntegrationClients(
    "space",
    packageId,
    authKey,
  );
  const { data: detail } = useIntegrationDetail(packageId);
  // What connect will ACTUALLY send: `OAuth2Strategy.begin` prefers the default client's own
  // `redirect_uri` over the platform callback (`clientRedirectUri ?? redirectUri`).
  const redirectUri =
    clients?.find((c) => c.is_default)?.redirect_uri || detail?.platform_redirect_uri;
  if (!clientsLoading && !redirectUri) return null;
  return (
    <section className="mt-8">
      <h4 className="mb-4 text-sm font-medium">{t("integration.presentation.technicalDetails")}</h4>
      {redirectUri && (
        <div className="mb-4 space-y-2">
          <p className="text-muted-foreground text-sm">
            {t("integration.oauthClient.platformRedirectUri")}
          </p>
          {clientsLoading || !redirectUri ? (
            <Skeleton className="h-9 w-full" />
          ) : (
            <CopyBlock value={redirectUri} testId={`platform-redirect-uri-${authKey}`} />
          )}
        </div>
      )}
    </section>
  );
}

/** Per-auth admin configuration: manifest pins, the OAuth clients table and the redirect URI to register. */
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
  const authorizedUris = authDecl.authorized_uris ?? [];

  return (
    <section data-testid={`auth-config-${status.auth_key}`}>
      <p className="text-muted-foreground mb-5 text-sm">
        {t(
          isOAuth
            ? "integration.presentation.oauthDescription"
            : "integration.presentation.credentialsDescription",
        )}
      </p>
      {(status.resource || authorizedUris.length > 0) && (
        <dl className="mb-6">
          {status.resource && (
            <SettingValue label={t("integration.auth.resource")}>
              <CopyBlock value={status.resource} />
            </SettingValue>
          )}
          {authorizedUris.length > 0 && (
            <SettingValue label={t("integration.structure.addresses")}>
              {authorizedUris.map((uri) => (
                <CopyBlock key={uri} value={uri} />
              ))}
            </SettingValue>
          )}
        </dl>
      )}
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
