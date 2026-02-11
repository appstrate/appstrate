import { useState } from "react";
import { useServices } from "../hooks/use-services";
import { useConnect, useDisconnect, useConnectApiKey } from "../hooks/use-mutations";
import { Spinner } from "../components/spinner";
import { ApiKeyModal } from "../components/api-key-modal";
import { formatDateField } from "../lib/markdown";

export function ServicesListPage() {
  const { data: integrations, isLoading, error } = useServices();
  const connectMutation = useConnect();
  const disconnectMutation = useDisconnect();
  const apiKeyMutation = useConnectApiKey();

  const [apiKeyProvider, setApiKeyProvider] = useState<{
    uniqueKey: string;
    displayName: string;
  } | null>(null);

  if (isLoading) {
    return (
      <div className="empty-state">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <p>Impossible de charger les services.</p>
        <p className="empty-hint">{error.message}</p>
      </div>
    );
  }

  if (!integrations || integrations.length === 0) {
    return (
      <div className="empty-state">
        <p>Aucun service configure.</p>
        <p className="empty-hint">Configurez des integrations dans Nango pour les voir ici.</p>
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
      <div className="section-title">Services</div>
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
                  {isConnected ? "Connecte" : "Non connecte"}
                </span>
                {connDate && <span className="service-date">{connDate}</span>}
              </div>
              <div className="service-card-actions">
                {isConnected ? (
                  <>
                    <button
                      onClick={() => {
                        if (confirm(`Deconnecter le service "${svc.uniqueKey}" ?`)) {
                          disconnectMutation.mutate(svc.uniqueKey);
                        }
                      }}
                      disabled={disconnectMutation.isPending}
                    >
                      Deconnecter
                    </button>
                    <button
                      onClick={() => handleConnect(svc)}
                      disabled={connectMutation.isPending || apiKeyMutation.isPending}
                    >
                      Reconnecter
                    </button>
                  </>
                ) : (
                  <button
                    className="primary"
                    onClick={() => handleConnect(svc)}
                    disabled={connectMutation.isPending || apiKeyMutation.isPending}
                  >
                    Connecter
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
