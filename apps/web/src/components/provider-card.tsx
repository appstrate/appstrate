import { useTranslation } from "react-i18next";
import { authModeI18nKey } from "../lib/auth-mode";
import { getServiceStatusDisplay } from "../lib/service-status";
import type { ProviderConfig, Integration } from "@appstrate/shared-types";

interface ProviderCardProps {
  provider: ProviderConfig;
  integration?: Integration;
  isAdmin: boolean;
  onConnect: (svc: { uniqueKey: string; displayName: string; authMode?: string }) => void;
  onDisconnect: (provider: string, connectionId?: string) => void;
  onEdit: (p: ProviderConfig) => void;
  onDelete: (p: ProviderConfig) => void;
  connectPending: boolean;
  disconnectPending: boolean;
}

export function ProviderCard({
  provider,
  integration,
  isAdmin,
  onConnect,
  onDisconnect,
  onEdit,
  onDelete,
  connectPending,
  disconnectPending,
}: ProviderCardProps) {
  const { t } = useTranslation(["settings", "common"]);

  const isConnected = integration?.status === "connected";
  const needsReconnection = integration?.status === "needs_reconnection";
  const connDate = integration?.connectedAt
    ? new Date(integration.connectedAt).toLocaleDateString()
    : "";

  const status = integration?.status ?? "not_connected";
  const { statusDotClass, badgeClass, statusLabel } = getServiceStatusDisplay(status, t);
  const isBuiltIn = provider.source === "built-in";

  return (
    <div className="service-card">
      <div className="service-card-header">
        {(provider.iconUrl || integration?.logo) && (
          <img
            className="service-logo"
            src={provider.iconUrl || integration?.logo}
            alt={provider.displayName}
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        )}
        <div className="service-info">
          <h3 className="provider-name">{provider.displayName}</h3>
          <div className="provider-badges">
            <span className="badge badge-pending">
              {t(authModeI18nKey(provider.authMode), { defaultValue: provider.authMode })}
            </span>
            {isBuiltIn && <span className="badge badge-dim">{t("providers.builtIn")}</span>}
            {provider.source === "custom" && (
              <span className="badge badge-dim">{t("providers.custom")}</span>
            )}
            {provider.usedByFlows != null && provider.usedByFlows > 0 && (
              <span className="badge badge-success">
                {t("providers.usedByFlows", { count: provider.usedByFlows })}
              </span>
            )}
          </div>
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
                if (confirm(t("services.disconnectConfirm", { name: provider.id }))) {
                  onDisconnect(provider.id, integration?.connectionId);
                }
              }}
              disabled={disconnectPending}
            >
              {t("btn.disconnect")}
            </button>
            <button
              onClick={() =>
                onConnect({
                  uniqueKey: provider.id,
                  displayName: provider.displayName,
                  authMode: integration?.authMode,
                })
              }
              disabled={connectPending}
            >
              {t("btn.reconnect")}
            </button>
          </>
        ) : (
          <button
            className="primary"
            onClick={() =>
              onConnect({
                uniqueKey: provider.id,
                displayName: provider.displayName,
                authMode: integration?.authMode,
              })
            }
            disabled={connectPending}
          >
            {needsReconnection ? t("btn.reconnect") : t("btn.connect")}
          </button>
        )}
        {isAdmin && !isBuiltIn && (
          <>
            <button onClick={() => onEdit(provider)}>{t("btn.edit")}</button>
            <button
              onClick={() => onDelete(provider)}
              disabled={!!provider.usedByFlows && provider.usedByFlows > 0}
              title={
                provider.usedByFlows && provider.usedByFlows > 0
                  ? t("providers.cannotDeleteInUse")
                  : undefined
              }
            >
              {t("btn.delete")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
