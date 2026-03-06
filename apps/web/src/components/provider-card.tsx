import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
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
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-start gap-3">
        {(provider.iconUrl || integration?.logo) && (
          <img
            className="h-8 w-8 rounded object-contain shrink-0"
            src={provider.iconUrl || integration?.logo}
            alt={provider.displayName}
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        )}
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-foreground">{provider.displayName}</h3>
          <div className="mt-1 flex flex-wrap gap-1">
            <span className="text-[0.7rem] px-2 py-0.5 rounded bg-muted/50 text-muted-foreground font-medium">
              {t(authModeI18nKey(provider.authMode), { defaultValue: provider.authMode })}
            </span>
            {isBuiltIn && (
              <span className="text-[0.7rem] px-2 py-0.5 rounded bg-muted/50 text-muted-foreground font-medium">
                {t("providers.builtIn")}
              </span>
            )}
            {provider.source === "custom" && (
              <span className="text-[0.7rem] px-2 py-0.5 rounded bg-muted/50 text-muted-foreground font-medium">
                {t("providers.custom")}
              </span>
            )}
            {provider.usedByFlows != null && provider.usedByFlows > 0 && (
              <span className="text-[0.7rem] px-2 py-0.5 rounded bg-success/15 text-success font-medium">
                {t("providers.usedByFlows", { count: provider.usedByFlows })}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs">
        <span
          className={`inline-block h-2 w-2 rounded-full ${statusDotClass === "connected" ? "bg-success" : statusDotClass === "warning" ? "bg-warning" : "bg-destructive"}`}
        />
        <span
          className={`text-[0.7rem] px-2 py-0.5 rounded font-medium ${badgeClass === "badge-success" ? "bg-success/15 text-success" : badgeClass === "badge-warning" ? "bg-warning/15 text-warning" : "bg-destructive/15 text-destructive"}`}
        >
          {statusLabel}
        </span>
        {connDate && <span className="text-muted-foreground">{connDate}</span>}
      </div>

      <div className="flex items-center gap-2 pt-1 border-t border-border">
        {isConnected ? (
          <>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                if (confirm(t("services.disconnectConfirm", { name: provider.id }))) {
                  onDisconnect(provider.id, integration?.connectionId);
                }
              }}
              disabled={disconnectPending}
            >
              {t("btn.disconnect")}
            </Button>
            <Button
              variant="outline"
              size="sm"
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
            </Button>
          </>
        ) : (
          <Button
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
          </Button>
        )}
        {isAdmin && !isBuiltIn && (
          <>
            <Button variant="ghost" size="sm" onClick={() => onEdit(provider)}>
              {t("btn.edit")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onDelete(provider)}
              disabled={!!provider.usedByFlows && provider.usedByFlows > 0}
              title={
                provider.usedByFlows && provider.usedByFlows > 0
                  ? t("providers.cannotDeleteInUse")
                  : undefined
              }
            >
              {t("btn.delete")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
