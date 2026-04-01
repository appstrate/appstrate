import { useTranslation } from "react-i18next";
import { Unplug, Link2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "../page-states";
import { usePackageDetail } from "../../hooks/use-packages";
import { useOrg } from "../../hooks/use-org";
import { useConnect, useDisconnect } from "../../hooks/use-mutations";
import { useCurrentProfileId, profileIdParam } from "../../hooks/use-current-profile";
import { useFlowDetailUI } from "../../stores/flow-detail-ui-store";
import { computeProvidersSummary, connectedLabelWithProfile } from "../../lib/provider-status";
import { useConnectionProfiles } from "../../hooks/use-connection-profiles";
import { ProfileSelector } from "../profile-selector";
import { OrgProfileSelector } from "../org-profile-selector";
import { ProviderConfigBadge } from "../provider-config-badge";
import { ProviderConfigureButton } from "../provider-configure-button";
import { ProviderCard } from "../provider-card";

export function FlowProvidersSection({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["flows", "common", "settings"]);
  const { isOrgAdmin } = useOrg();
  const { data: detail } = usePackageDetail("flow", packageId);
  const profileId = useCurrentProfileId();
  const pParam = profileIdParam(profileId);
  const { data: profiles } = useConnectionProfiles();

  const connectMutation = useConnect();
  const disconnectMutation = useDisconnect();

  const populatedProviders = detail?.populatedProviders;
  const setApiKeyService = useFlowDetailUI((s) => s.setApiKeyService);
  const setCustomCredService = useFlowDetailUI((s) => s.setCustomCredService);

  const getProviderConfig = (providerId: string) => populatedProviders?.[providerId];

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

  if (detail.dependencies.providers.length === 0) {
    return (
      <EmptyState
        message={t("detail.emptyConnectors")}
        hint={t("detail.emptyConnectorsHint")}
        icon={Unplug}
        compact
      />
    );
  }

  const summary = computeProvidersSummary(detail.dependencies.providers, t);
  const flowProviderIds = detail.dependencies.providers.map((p) => p.id);
  const forcedOrgProfileId = detail.forcedOrgProfileId ?? null;

  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm text-muted-foreground">
          {summary && (
            <>
              {summary.connectedCount > 0 &&
                t("detail.providersSummaryOk", { connected: summary.connectedCount })}
              {summary.connectedCount > 0 && summary.actionCount > 0 && " — "}
              {summary.actionCount > 0 && (
                <span className="text-warning font-medium">
                  {t("detail.providersSummaryAction", { count: summary.actionCount })}
                </span>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-3">
          <OrgProfileSelector
            flowProviderIds={flowProviderIds}
            forcedOrgProfileId={forcedOrgProfileId}
          />
          <ProfileSelector />
        </div>
      </div>
      <div className="grid gap-3 grid-cols-1 md:grid-cols-2 mb-4">
        {detail.dependencies.providers.map((svc) => {
          const isConnected = svc.status === "connected";
          const authMode = getProviderAuthMode(svc);
          const providerConfig = getProviderConfig(svc.provider);
          const displayName = providerConfig?.displayName ?? svc.name ?? svc.id;
          const iconUrl = providerConfig?.iconUrl;
          const hasScopeIssue = isConnected && svc.scopesSufficient === false;
          const isOrgBinding = svc.source === "org_binding";

          // For user_profile providers, connect on personal profile
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

          let actionButtons: React.ReactNode;

          if (isOrgBinding && isConnected) {
            // Provider bound in org profile and connected — read-only
            actionButtons = (
              <span className="inline-flex items-center gap-1 text-xs text-primary">
                <Link2 className="size-3" />
                {t("detail.orgBinding", { defaultValue: "Shared by organization" })}
              </span>
            );
          } else if (isOrgBinding && !isConnected) {
            // Provider bound in org profile but credentials expired — admin issue
            actionButtons = (
              <span className="inline-flex items-center gap-1 text-xs text-warning">
                <AlertTriangle className="size-3" />
                {t("detail.orgBindingNotConnected", {
                  defaultValue: "Shared connection unavailable — contact your administrator",
                })}
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
                <span className="text-xs text-emerald-500">
                  {connectedLabelWithProfile(
                    t("settings:providers.connected"),
                    profiles,
                    profileId,
                  )}
                </span>
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
            <ProviderCard
              key={svc.id}
              displayName={displayName}
              description={svc.description}
              iconUrl={iconUrl}
              badges={
                isOrgAdmin && providerConfig ? (
                  <ProviderConfigBadge enabled={providerConfig.enabled} />
                ) : undefined
              }
              actions={
                <>
                  {actionButtons}
                  {isOrgAdmin && providerConfig && (
                    <ProviderConfigureButton
                      provider={providerConfig}
                      callbackUrl={detail?.callbackUrl}
                    />
                  )}
                </>
              }
            />
          );
        })}
      </div>
    </>
  );
}
