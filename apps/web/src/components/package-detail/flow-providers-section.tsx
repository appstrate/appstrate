import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { usePackageDetail } from "../../hooks/use-packages";
import { useOrg } from "../../hooks/use-org";
import {
  useConnect,
  useBindAdminProvider,
  useUnbindAdminProvider,
  useDisconnect,
} from "../../hooks/use-mutations";
import { useCurrentProfileId, profileIdParam } from "../../hooks/use-current-profile";
import { useProviders } from "../../hooks/use-providers";
import { useFlowDetailUI } from "../../stores/flow-detail-ui-store";
import { computeProvidersSummary } from "../../lib/provider-status";
import { ProviderConfigBadge } from "../provider-config-badge";
import { ProviderConfigureButton } from "../provider-configure-button";

export function FlowProvidersSection({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["flows", "common", "settings"]);
  const { isOrgAdmin } = useOrg();
  const { data: detail } = usePackageDetail("flow", packageId);
  const profileId = useCurrentProfileId();
  const pParam = profileIdParam(profileId);

  const connectMutation = useConnect();
  const bindAdmin = useBindAdminProvider(packageId);
  const unbindAdmin = useUnbindAdminProvider(packageId);
  const disconnectMutation = useDisconnect();

  const { data: providersData } = useProviders();
  const providers = providersData?.providers;
  const setApiKeyService = useFlowDetailUI((s) => s.setApiKeyService);
  const setCustomCredService = useFlowDetailUI((s) => s.setCustomCredService);

  const getProviderConfig = (providerId: string) => providers?.find((p) => p.id === providerId);

  const getProviderAuthMode = (svc: {
    provider: string;
    authMode?: string;
  }): string | undefined => {
    if (svc.authMode) return svc.authMode;
    const pDef = getProviderConfig(svc.provider);
    return pDef?.authMode === "api_key"
      ? "API_KEY"
      : pDef?.authMode === "oauth2"
        ? "OAUTH2"
        : undefined;
  };

  const isCredentialAuth = (provider: string): boolean => {
    const pDef = getProviderConfig(provider);
    return !!pDef?.credentialSchema;
  };

  if (!detail) return null;

  const summary = computeProvidersSummary(detail.requires.providers, t);

  return (
    <>
      {summary && (
        <div className="text-sm text-muted-foreground mb-2">
          {summary.connectedCount > 0 &&
            t("detail.servicesSummaryOk", { connected: summary.connectedCount })}
          {summary.connectedCount > 0 && summary.actionCount > 0 && " — "}
          {summary.actionCount > 0 && (
            <span className="text-warning font-medium">
              {t("detail.servicesSummaryAction", { count: summary.actionCount })}
            </span>
          )}
        </div>
      )}
      <div className="grid gap-3 grid-cols-1 md:grid-cols-2 mb-4">
        {detail.requires.providers.map((svc) => {
          const isConnected = svc.status === "connected";
          const isAdminMode = svc.connectionMode === "admin";
          const authMode = getProviderAuthMode(svc);
          const providerConfig = getProviderConfig(svc.provider);
          const displayName = providerConfig?.displayName ?? svc.name ?? svc.id;
          const iconUrl = providerConfig?.iconUrl;
          const hasScopeIssue = isConnected && svc.scopesSufficient === false;

          const handleProviderConnect = () => {
            if (authMode === "API_KEY") {
              setApiKeyService({ provider: svc.provider, id: svc.id });
            } else if (isCredentialAuth(svc.provider)) {
              setCustomCredService({ provider: svc.provider, id: svc.id, name: svc.name });
            } else {
              connectMutation.mutate({
                provider: svc.provider,
                scopes: svc.scopesRequired,
                ...pParam,
              });
            }
          };

          const handleBind = async () => {
            try {
              await bindAdmin.mutateAsync(svc.id);
            } catch (err) {
              const msg = err instanceof Error ? err.message : "";
              if (!msg.includes("connexion active")) {
                alert(t("error.prefix", { message: msg }));
                return;
              }
              try {
                if (authMode === "API_KEY") {
                  setApiKeyService({ provider: svc.provider, id: svc.id, bindAfter: true });
                  return;
                }
                if (isCredentialAuth(svc.provider)) {
                  setCustomCredService({
                    provider: svc.provider,
                    id: svc.id,
                    name: svc.name,
                    bindAfter: true,
                  });
                  return;
                }
                await connectMutation.mutateAsync({
                  provider: svc.provider,
                  scopes: svc.scopesRequired,
                });
                await bindAdmin.mutateAsync(svc.id);
              } catch (retryErr) {
                const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                alert(t("error.prefix", { message: retryMsg }));
              }
            }
          };

          // --- Render action buttons based on state ---
          let actionButtons: React.ReactNode;
          if (isAdminMode && svc.adminProvided && isConnected) {
            actionButtons = (
              <div className="flex items-center gap-2">
                <span className="text-xs text-emerald-500">{t("settings:services.connected")}</span>
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  {t("admin")}
                </span>
                {isOrgAdmin && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => unbindAdmin.mutate(svc.id)}
                    disabled={unbindAdmin.isPending}
                  >
                    {t("detail.unbind")}
                  </Button>
                )}
              </div>
            );
          } else if (isAdminMode) {
            actionButtons = isOrgAdmin ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={handleBind}
                disabled={bindAdmin.isPending || connectMutation.isPending}
              >
                {t("detail.bindAccount")}
              </Button>
            ) : (
              <span className="rounded bg-warning/10 px-1.5 py-0.5 text-xs text-warning">
                {t("detail.pending")}
              </span>
            );
          } else if (svc.status === "needs_reconnection") {
            actionButtons = (
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs border-warning/30 text-warning hover:bg-warning/10"
                onClick={handleProviderConnect}
                disabled={connectMutation.isPending}
              >
                {t("detail.reconnect", { defaultValue: "Reconnect" })}
              </Button>
            );
          } else if (isConnected) {
            actionButtons = (
              <div className="flex items-center gap-2">
                <span className="text-xs text-emerald-500">{t("settings:services.connected")}</span>
                {hasScopeIssue && svc.scopesMissing && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs border-warning/30 text-warning hover:bg-warning/10"
                    onClick={handleProviderConnect}
                    disabled={connectMutation.isPending}
                    title={`Missing: ${svc.scopesMissing.join(", ")}`}
                  >
                    {t("detail.updatePermissions", { defaultValue: "Update permissions" })}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    if (confirm(t("detail.disconnectConfirm", { name: displayName }))) {
                      disconnectMutation.mutate({ provider: svc.provider, ...pParam });
                    }
                  }}
                  disabled={disconnectMutation.isPending}
                >
                  {t("detail.disconnect")}
                </Button>
              </div>
            );
          } else {
            actionButtons = (
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={handleProviderConnect}
              >
                {t("detail.connect")}
              </Button>
            );
          }

          return (
            <div key={svc.id} className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {iconUrl && (
                    <img src={iconUrl} alt="" className="h-5 w-5 shrink-0 rounded object-contain" />
                  )}
                  <span className="text-sm font-medium text-foreground truncate">
                    {displayName}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {isOrgAdmin && providerConfig && (
                    <ProviderConfigBadge enabled={providerConfig.enabled} />
                  )}
                </div>
              </div>
              {svc.description && (
                <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{svc.description}</p>
              )}
              <div className="mt-3 pt-3 border-t border-border flex items-center justify-between gap-2">
                {actionButtons}
                {isOrgAdmin && providerConfig && (
                  <ProviderConfigureButton
                    provider={providerConfig}
                    callbackUrl={providersData?.callbackUrl}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
