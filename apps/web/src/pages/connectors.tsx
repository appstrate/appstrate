import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useOrg } from "../hooks/use-org";
import { useServices } from "../hooks/use-services";
import { useCurrentProfileId, profileIdParam } from "../hooks/use-current-profile";
import {
  useConnect,
  useDisconnect,
  useConnectApiKey,
  useConnectCredentials,
} from "../hooks/use-mutations";
import { useProviders } from "../hooks/use-providers";
import { ApiKeyModal } from "../components/api-key-modal";
import { CustomCredentialsModal } from "../components/custom-credentials-modal";
import { ProfileSelector } from "../components/profile-selector";
import { LoadingState, ErrorState } from "../components/page-states";
import { getServiceStatusDisplay } from "../lib/service-status";
import type { JSONSchemaObject } from "@appstrate/shared-types";

export function ConnectorsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { currentOrg } = useOrg();
  const profileId = useCurrentProfileId();
  const pParam = profileIdParam(profileId);
  const { data: integrations, isLoading, error } = useServices();
  const connectMutation = useConnect();
  const disconnectMutation = useDisconnect();
  const apiKeyMutation = useConnectApiKey();
  const credentialsMutation = useConnectCredentials();
  const { data: providers } = useProviders();

  const [apiKeyProvider, setApiKeyProvider] = useState<{
    uniqueKey: string;
    displayName: string;
  } | null>(null);

  const [credProvider, setCredProvider] = useState<{
    uniqueKey: string;
    displayName: string;
    schema: JSONSchemaObject;
  } | null>(null);

  const isCredentialAuth = (providerId?: string): boolean => {
    const pDef = providers?.find((p) => p.id === providerId);
    return !!pDef?.credentialSchema;
  };

  const handleConnect = (svc: { uniqueKey: string; displayName: string; authMode?: string }) => {
    if (svc.authMode === "API_KEY") {
      setApiKeyProvider({ uniqueKey: svc.uniqueKey, displayName: svc.displayName });
    } else if (isCredentialAuth(svc.uniqueKey)) {
      const pDef = providers?.find((p) => p.id === svc.uniqueKey);
      const schema = (pDef?.credentialSchema as unknown as JSONSchemaObject) ?? {
        type: "object",
        properties: { url: { type: "string", description: "Proxy URL" } },
        required: ["url"],
      };
      setCredProvider({ uniqueKey: svc.uniqueKey, displayName: svc.displayName, schema });
    } else {
      connectMutation.mutate({ provider: svc.uniqueKey, ...pParam });
    }
  };

  return (
    <>
      <div className="header-row">
        <h2>{t("connectors.pageTitle", { orgName: currentOrg?.name })}</h2>
        <ProfileSelector />
      </div>

      <div className="service-card service-card-spaced">
        <div className="connectors-intro">
          <p className="service-provider">
            {t("connectors.orgDescription", { orgName: currentOrg?.name })}{" "}
            <Link to="/org-settings?tab=providers" className="link-inline">
              {t("connectors.addMoreProviders")}
            </Link>
          </p>
        </div>
      </div>

      {isLoading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={error.message} />
      ) : !integrations || integrations.length === 0 ? (
        <div className="empty-state">
          <p>{t("services.empty")}</p>
          <p className="empty-hint">{t("services.emptyHint")}</p>
        </div>
      ) : (
        <div className="services-grid">
          {integrations.map((svc) => {
            const isConnected = svc.status === "connected";
            const needsReconnection = svc.status === "needs_reconnection";
            const connDate = svc.connectedAt ? new Date(svc.connectedAt).toLocaleDateString() : "";
            const { statusDotClass, badgeClass, statusLabel } = getServiceStatusDisplay(
              svc.status,
              t,
            );

            return (
              <div key={svc.uniqueKey} className="service-card">
                <div className="service-card-header">
                  {svc.logo && (
                    <img className="service-logo" src={svc.logo} alt={svc.displayName} />
                  )}
                  <div className="service-info">
                    <h3>{svc.displayName}</h3>
                    <span className="service-provider">{svc.provider}</span>
                  </div>
                </div>
                <div className="service-card-status">
                  <span className={`status-dot ${statusDotClass}`} />
                  <span className={`badge ${badgeClass}`}>{statusLabel}</span>
                  {connDate && <span className="service-date">{connDate}</span>}
                </div>
                <div className="service-card-actions">
                  {isConnected ? (
                    <>
                      <button
                        onClick={() => {
                          if (confirm(t("services.disconnectConfirm", { name: svc.uniqueKey }))) {
                            disconnectMutation.mutate({
                              provider: svc.uniqueKey,
                              ...(svc.connectionId ? { connectionId: svc.connectionId } : pParam),
                            });
                          }
                        }}
                        disabled={disconnectMutation.isPending}
                      >
                        {t("btn.disconnect")}
                      </button>
                      <button
                        onClick={() => handleConnect(svc)}
                        disabled={
                          connectMutation.isPending ||
                          apiKeyMutation.isPending ||
                          credentialsMutation.isPending
                        }
                      >
                        {t("btn.reconnect")}
                      </button>
                    </>
                  ) : (
                    <button
                      className="primary"
                      onClick={() => handleConnect(svc)}
                      disabled={
                        connectMutation.isPending ||
                        apiKeyMutation.isPending ||
                        credentialsMutation.isPending
                      }
                    >
                      {needsReconnection ? t("btn.reconnect") : t("btn.connect")}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ApiKeyModal
        open={!!apiKeyProvider}
        onClose={() => setApiKeyProvider(null)}
        providerName={apiKeyProvider?.displayName ?? ""}
        isPending={apiKeyMutation.isPending}
        onSubmit={(apiKey) => {
          if (apiKeyProvider) {
            apiKeyMutation.mutate(
              { provider: apiKeyProvider.uniqueKey, apiKey, ...pParam },
              { onSuccess: () => setApiKeyProvider(null) },
            );
          }
        }}
      />

      {credProvider && (
        <CustomCredentialsModal
          open
          onClose={() => setCredProvider(null)}
          schema={credProvider.schema}
          serviceId={credProvider.uniqueKey}
          serviceName={credProvider.displayName}
          isPending={credentialsMutation.isPending}
          onSubmit={(credentials) => {
            credentialsMutation.mutate(
              { provider: credProvider.uniqueKey, credentials, ...pParam },
              { onSuccess: () => setCredProvider(null) },
            );
          }}
        />
      )}
    </>
  );
}
