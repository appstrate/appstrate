import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, RefreshCw } from "lucide-react";
import {
  useRegistryStatus,
  useRegistryConnect,
  useRegistryDisconnect,
  useRegistryScopes,
  useClaimScope,
} from "../hooks/use-registry";
import { LoadingState, EmptyState } from "../components/page-states";
import { Spinner } from "../components/spinner";
import { useQueryClient } from "@tanstack/react-query";

function StatusBadge({ status }: { status: "connected" | "expired" | "disconnected" }) {
  const { t } = useTranslation(["settings"]);
  const labels: Record<string, string> = {
    connected: t("registry.statusConnected"),
    expired: t("registry.statusExpired"),
    disconnected: t("registry.statusDisconnected"),
  };
  const classes: Record<string, string> = {
    connected: "badge badge-success",
    expired: "badge badge-warning",
    disconnected: "badge badge-muted",
  };
  return <span className={classes[status]}>{labels[status]}</span>;
}

export function MarketplaceConnectionPage() {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();
  const { data: status, isLoading: statusLoading } = useRegistryStatus();
  const connectMutation = useRegistryConnect();
  const disconnectMutation = useRegistryDisconnect();
  const { data: scopes, isLoading: scopesLoading } = useRegistryScopes();
  const claimScopeMutation = useClaimScope();
  const [newScopeName, setNewScopeName] = useState("");
  const [testResult, setTestResult] = useState<"success" | "failed" | null>(null);
  const [testing, setTesting] = useState(false);

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      await queryClient.invalidateQueries({ queryKey: ["registry", "status"] });
      const fresh = queryClient.getQueryData<{
        connected: boolean;
        expired?: boolean;
      }>(["registry", "status"]);
      setTestResult(fresh?.connected && !fresh?.expired ? "success" : "failed");
    } catch {
      setTestResult("failed");
    } finally {
      setTesting(false);
    }
  };

  const handleClaimScope = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newScopeName.trim();
    if (!trimmed) return;
    claimScopeMutation.mutate(trimmed, {
      onSuccess: () => setNewScopeName(""),
    });
  };

  if (statusLoading) {
    return (
      <div className="marketplace-page">
        <LoadingState />
      </div>
    );
  }

  const connectionStatus: "connected" | "expired" | "disconnected" = status?.connected
    ? status.expired
      ? "expired"
      : "connected"
    : "disconnected";

  return (
    <div className="marketplace-page">
      <Link to="/marketplace" className="breadcrumb">
        <ArrowLeft size={14} />
        <span>{t("marketplace.backToMarketplace")}</span>
      </Link>

      <div className="page-header">
        <h2>{t("marketplace.connectionTitle")}</h2>
        <p className="description">{t("marketplace.connectionDesc")}</p>
      </div>

      {!status || !status.connected ? (
        <>
          <div className="service-card service-card-spaced">
            <div className="connectors-intro">
              <p className="service-provider">{t("registry.description")}</p>
            </div>
          </div>
          <div className="tab-toolbar">
            <StatusBadge status={connectionStatus} />
            <button
              className="primary"
              onClick={() => connectMutation.mutate()}
              disabled={connectMutation.isPending}
            >
              {connectMutation.isPending ? <Spinner /> : t("registry.connect")}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="service-card service-card-spaced">
            <div className="service-card-header">
              <div className="service-info">
                <h3>{status.username}</h3>
                <span className="service-provider">
                  <StatusBadge status={connectionStatus} />
                  {status.expiresAt && (
                    <span style={{ marginLeft: "0.5rem" }}>
                      {t("registry.expiresAt", {
                        date: new Date(status.expiresAt).toLocaleDateString(),
                      })}
                    </span>
                  )}
                </span>
              </div>
              <div className="service-card-actions">
                <button onClick={handleTestConnection} disabled={testing} className="btn-sm">
                  {testing ? <Spinner /> : <RefreshCw size={14} />}
                  {t("registry.testConnection")}
                </button>
                <button
                  onClick={() => disconnectMutation.mutate()}
                  disabled={disconnectMutation.isPending}
                >
                  {t("registry.disconnect")}
                </button>
              </div>
            </div>
            {testResult && (
              <div
                className={`toast ${testResult === "success" ? "toast-success" : "toast-error"}`}
              >
                {testResult === "success" ? t("registry.testSuccess") : t("registry.testFailed")}
              </div>
            )}
          </div>

          <div className="section-title section-title-mt">{t("registry.scopes")}</div>
          {scopesLoading ? (
            <LoadingState />
          ) : scopes && scopes.length > 0 ? (
            <div className="services-grid">
              {scopes.map((s) => (
                <div key={s.name} className="service-card">
                  <div className="service-card-header service-card-header-flush">
                    <div className="service-info service-info-sm">
                      <h3>{s.name}</h3>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState message={t("registry.noScopes")} compact />
          )}

          <div className="service-card service-card-spaced">
            <form onSubmit={handleClaimScope} className="form-compact form-inline">
              <input
                type="text"
                value={newScopeName}
                onChange={(e) => setNewScopeName(e.target.value)}
                placeholder={t("registry.scopeName")}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newScopeName.trim() && !claimScopeMutation.isPending)
                    handleClaimScope(e);
                }}
              />
              <button
                className="primary"
                type="submit"
                disabled={claimScopeMutation.isPending || !newScopeName.trim()}
              >
                {claimScopeMutation.isPending ? <Spinner /> : t("registry.createScope")}
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
