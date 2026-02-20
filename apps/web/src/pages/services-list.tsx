import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useServices } from "../hooks/use-services";
import { useConnect, useDisconnect, useConnectApiKey } from "../hooks/use-mutations";
import { ApiKeyModal } from "../components/api-key-modal";
import { formatDateField } from "../lib/markdown";
import { LoadingState, ErrorState } from "../components/page-states";

export function ServicesListPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { data: integrations, isLoading, error } = useServices();
  const connectMutation = useConnect();
  const disconnectMutation = useDisconnect();
  const apiKeyMutation = useConnectApiKey();

  const [apiKeyProvider, setApiKeyProvider] = useState<{
    uniqueKey: string;
    displayName: string;
  } | null>(null);

  if (isLoading) return <LoadingState />;

  if (error) return <ErrorState message={error.message} />;

  if (!integrations || integrations.length === 0) {
    return (
      <div className="empty-state">
        <p>{t("services.empty")}</p>
        <p className="empty-hint">{t("services.emptyHint")}</p>
      </div>
    );
  }

  const handleConnect = (svc: { uniqueKey: string; displayName: string; authMode?: string }) => {
    if (svc.authMode === "API_KEY") {
      setApiKeyProvider({ uniqueKey: svc.uniqueKey, displayName: svc.displayName });
    } else {
      connectMutation.mutate(svc.uniqueKey);
    }
  };

  return (
    <>
      <div className="section-title">{t("services.title")}</div>
      <div className="services-grid">
        {integrations.map((svc) => {
          const isConnected = svc.status === "connected";
          const connDate = svc.connectedAt ? formatDateField(svc.connectedAt) : "";

          return (
            <div key={svc.uniqueKey} className="service-card">
              <div className="service-card-header">
                {svc.logo && <img className="service-logo" src={svc.logo} alt={svc.displayName} />}
                <div className="service-info">
                  <h3>{svc.displayName}</h3>
                  <span className="service-provider">{svc.provider}</span>
                </div>
              </div>
              <div className="service-card-status">
                <span className={`status-dot ${isConnected ? "connected" : "disconnected"}`} />
                <span className={`badge ${isConnected ? "badge-success" : "badge-failed"}`}>
                  {isConnected ? t("services.connected") : t("services.notConnected")}
                </span>
                {connDate && <span className="service-date">{connDate}</span>}
              </div>
              <div className="service-card-actions">
                {isConnected ? (
                  <>
                    <button
                      onClick={() => {
                        if (confirm(t("services.disconnectConfirm", { name: svc.uniqueKey }))) {
                          disconnectMutation.mutate(svc.uniqueKey);
                        }
                      }}
                      disabled={disconnectMutation.isPending}
                    >
                      {t("btn.disconnect")}
                    </button>
                    <button
                      onClick={() => handleConnect(svc)}
                      disabled={connectMutation.isPending || apiKeyMutation.isPending}
                    >
                      {t("btn.reconnect")}
                    </button>
                  </>
                ) : (
                  <button
                    className="primary"
                    onClick={() => handleConnect(svc)}
                    disabled={connectMutation.isPending || apiKeyMutation.isPending}
                  >
                    {t("btn.connect")}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <ApiKeyModal
        open={!!apiKeyProvider}
        onClose={() => setApiKeyProvider(null)}
        providerName={apiKeyProvider?.displayName ?? ""}
        isPending={apiKeyMutation.isPending}
        onSubmit={(apiKey) => {
          if (apiKeyProvider) {
            apiKeyMutation.mutate(
              { provider: apiKeyProvider.uniqueKey, apiKey },
              { onSuccess: () => setApiKeyProvider(null) },
            );
          }
        }}
      />
    </>
  );
}
