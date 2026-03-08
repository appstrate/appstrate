import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { usePackageDetail } from "../../hooks/use-packages";
import { useOrg } from "../../hooks/use-org";
import {
  useConnect,
  useBindAdminService,
  useUnbindAdminService,
  useDisconnect,
} from "../../hooks/use-mutations";
import { useCurrentProfileId, profileIdParam } from "../../hooks/use-current-profile";
import { useProviders } from "../../hooks/use-providers";
import { useFlowDetailUI } from "../../stores/flow-detail-ui-store";
import { getServiceStatusDisplay, computeServicesSummary } from "../../lib/service-status";

function ServiceIcon({ status, t }: { status: string; t: TFunction }) {
  const { statusLabel, statusIcon } = getServiceStatusDisplay(status, t);
  const colorMap: Record<string, string> = {
    connected: "text-success",
    not_connected: "text-destructive",
    needs_reconnection: "text-warning",
  };
  return (
    <span
      className={cn("text-sm leading-none", colorMap[status] ?? "text-muted-foreground")}
      aria-label={statusLabel}
    >
      {statusIcon}
    </span>
  );
}

export function FlowServicesSection({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["flows", "common"]);
  const { isOrgAdmin } = useOrg();
  const { data: detail } = usePackageDetail("flow", packageId);
  const profileId = useCurrentProfileId();
  const pParam = profileIdParam(profileId);

  const connectMutation = useConnect();
  const bindAdmin = useBindAdminService(packageId);
  const unbindAdmin = useUnbindAdminService(packageId);
  const disconnectMutation = useDisconnect();

  const { data: providersData } = useProviders();
  const providers = providersData?.providers;
  const setApiKeyService = useFlowDetailUI((s) => s.setApiKeyService);
  const setCustomCredService = useFlowDetailUI((s) => s.setCustomCredService);

  const getServiceAuthMode = (svc: { provider: string; authMode?: string }): string | undefined => {
    if (svc.authMode) return svc.authMode;
    const pDef = providers?.find((p) => p.id === svc.provider);
    return pDef?.authMode === "api_key"
      ? "API_KEY"
      : pDef?.authMode === "oauth2"
        ? "OAUTH2"
        : undefined;
  };

  const isCredentialAuth = (provider: string): boolean => {
    const pDef = providers?.find((p) => p.id === provider);
    return !!pDef?.credentialSchema;
  };

  if (!detail) return null;

  const summary = computeServicesSummary(detail.requires.services, t);

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
      <div className="flex flex-wrap gap-2 mb-4">
        {detail.requires.services.map((svc) => {
          const isConnected = svc.status === "connected";
          const isAdminMode = svc.connectionMode === "admin";
          const authMode = getServiceAuthMode(svc);
          const effectiveStatus =
            isConnected && svc.scopesSufficient === false ? "needs_reconnection" : svc.status;

          if (isAdminMode) {
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

            if (svc.adminProvided && isConnected) {
              return (
                <div
                  key={svc.id}
                  className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm"
                  title={svc.description}
                >
                  <ServiceIcon status="connected" t={t} />
                  {svc.name || svc.id}
                  <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    {t("admin")}
                  </span>
                  {isOrgAdmin && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="ml-1 h-6 px-2 text-xs"
                      onClick={() => unbindAdmin.mutate(svc.id)}
                      disabled={unbindAdmin.isPending}
                    >
                      {t("detail.unbind")}
                    </Button>
                  )}
                </div>
              );
            }
            return (
              <div
                key={svc.id}
                className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm"
                title={svc.description}
              >
                <ServiceIcon status="not_connected" t={t} />
                {svc.name || svc.id}
                {isOrgAdmin ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-1 h-6 px-2 text-xs"
                    onClick={handleBind}
                    disabled={bindAdmin.isPending || connectMutation.isPending}
                  >
                    {t("detail.bindAccount")}
                  </Button>
                ) : (
                  <span className="ml-1 rounded bg-warning/10 px-1.5 py-0.5 text-xs text-warning">
                    {t("detail.pending")}
                  </span>
                )}
              </div>
            );
          }

          const needsReconnection = svc.status === "needs_reconnection";
          const handleServiceConnect = () => {
            if (authMode === "API_KEY") {
              setApiKeyService({ provider: svc.provider, id: svc.id });
            } else if (isCredentialAuth(svc.provider)) {
              setCustomCredService({
                provider: svc.provider,
                id: svc.id,
                name: svc.name,
              });
            } else {
              connectMutation.mutate({
                provider: svc.provider,
                scopes: svc.scopesRequired,
                ...pParam,
              });
            }
          };
          const hasScopeIssue = isConnected && svc.scopesSufficient === false;

          if (needsReconnection) {
            return (
              <div
                key={svc.id}
                className="flex items-center gap-1.5 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-1.5 text-sm"
                title={svc.description}
              >
                <ServiceIcon status="needs_reconnection" t={t} />
                {svc.name || svc.id}
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-1 h-6 px-2 text-xs border-warning/30 text-warning hover:bg-warning/10"
                  onClick={handleServiceConnect}
                  disabled={connectMutation.isPending}
                >
                  {t("detail.reconnect", { defaultValue: "Reconnect" })}
                </Button>
              </div>
            );
          }
          if (isConnected) {
            return (
              <div
                key={svc.id}
                className={cn(
                  "flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm",
                  hasScopeIssue && "border-warning/30 bg-warning/5",
                )}
                title={svc.description}
              >
                <ServiceIcon status={effectiveStatus} t={t} />
                {svc.name || svc.id}
                {hasScopeIssue && svc.scopesMissing && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-1 h-6 px-2 text-xs border-warning/30 text-warning hover:bg-warning/10"
                    onClick={handleServiceConnect}
                    disabled={connectMutation.isPending}
                    title={`Missing: ${svc.scopesMissing.join(", ")}`}
                  >
                    {t("detail.updatePermissions", { defaultValue: "Update permissions" })}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-1 h-6 px-2 text-xs"
                  onClick={() => {
                    if (confirm(t("detail.disconnectConfirm", { name: svc.name || svc.id }))) {
                      disconnectMutation.mutate({
                        provider: svc.provider,
                        ...pParam,
                      });
                    }
                  }}
                  disabled={disconnectMutation.isPending}
                >
                  {t("detail.disconnect")}
                </Button>
              </div>
            );
          }
          return (
            <Button
              key={svc.id}
              type="button"
              variant="outline"
              className="flex items-center gap-1.5 border-dashed text-muted-foreground hover:border-primary hover:text-foreground"
              onClick={handleServiceConnect}
              title={svc.description}
            >
              <ServiceIcon status="not_connected" t={t} />
              {svc.name || svc.id}
              {` (${t("detail.connect")})`}
            </Button>
          );
        })}
      </div>
    </>
  );
}
