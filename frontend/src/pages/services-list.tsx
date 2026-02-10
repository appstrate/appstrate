import { useServices } from "../hooks/use-services";
import { useConnect, useDisconnect } from "../hooks/use-mutations";
import { Spinner } from "../components/spinner";

export function ServicesListPage() {
  const { data: integrations, isLoading, error } = useServices();
  const connectMutation = useConnect();
  const disconnectMutation = useDisconnect();

  if (isLoading) {
    return <div className="empty-state"><Spinner /></div>;
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
        <p className="empty-hint">
          Configurez des integrations dans Nango pour les voir ici.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="section-title">Services</div>
      <div className="services-grid">
        {integrations.map((svc) => {
          const isConnected = svc.status === "connected";
          const connDate = svc.connectedAt
            ? new Date(svc.connectedAt).toLocaleString("fr-FR", {
                day: "2-digit", month: "2-digit", year: "numeric",
                hour: "2-digit", minute: "2-digit",
              })
            : "";

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
                      onClick={() => connectMutation.mutate(svc.uniqueKey)}
                      disabled={connectMutation.isPending}
                    >
                      Reconnecter
                    </button>
                  </>
                ) : (
                  <button
                    className="primary"
                    onClick={() => connectMutation.mutate(svc.uniqueKey)}
                    disabled={connectMutation.isPending}
                  >
                    Connecter
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
