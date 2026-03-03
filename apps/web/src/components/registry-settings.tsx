import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useRegistryStatus,
  useRegistryConnect,
  useRegistryDisconnect,
  useRegistryScopes,
  useClaimScope,
} from "../hooks/use-registry";
import { LoadingState, EmptyState } from "./page-states";
import { Spinner } from "./spinner";

export function RegistrySettings() {
  const { t } = useTranslation(["settings", "common"]);
  const { data: status, isLoading: statusLoading } = useRegistryStatus();
  const connectMutation = useRegistryConnect();
  const disconnectMutation = useRegistryDisconnect();
  const { data: scopes, isLoading: scopesLoading } = useRegistryScopes();
  const claimScopeMutation = useClaimScope();
  const [newScopeName, setNewScopeName] = useState("");

  if (statusLoading) return <LoadingState />;

  if (!status) {
    return <EmptyState message={t("registry.notConfigured")} compact />;
  }

  if (!status.connected) {
    return (
      <>
        <div className="service-card service-card-spaced">
          <div className="connectors-intro">
            <p className="service-provider">{t("registry.description")}</p>
          </div>
        </div>
        <div className="tab-toolbar">
          <button
            className="primary"
            onClick={() => connectMutation.mutate()}
            disabled={connectMutation.isPending}
          >
            {connectMutation.isPending ? <Spinner /> : t("registry.connect")}
          </button>
        </div>
      </>
    );
  }

  const handleClaimScope = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newScopeName.trim();
    if (!trimmed) return;
    claimScopeMutation.mutate(trimmed, {
      onSuccess: () => setNewScopeName(""),
    });
  };

  return (
    <>
      <div className="service-card service-card-spaced">
        <div className="service-card-header">
          <div className="service-info">
            <h3>{status.username}</h3>
            <span className="service-provider">
              {status.expired
                ? t("registry.expired")
                : status.expiresAt
                  ? t("registry.expiresAt", {
                      date: new Date(status.expiresAt).toLocaleDateString(),
                    })
                  : t("registry.connected")}
            </span>
          </div>
          <button
            onClick={() => disconnectMutation.mutate()}
            disabled={disconnectMutation.isPending}
          >
            {t("registry.disconnect")}
          </button>
        </div>
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
  );
}
