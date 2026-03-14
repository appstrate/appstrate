import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useProviders } from "../hooks/use-providers";
import { useServices } from "../hooks/use-services";
import { useOrg } from "../hooks/use-org";
import {
  useConnect,
  useConnectApiKey,
  useConnectCredentials,
  useDisconnect,
} from "../hooks/use-mutations";
import { ApiKeyModal } from "../components/api-key-modal";
import { CustomCredentialsModal } from "../components/custom-credentials-modal";
import { Modal } from "../components/modal";
import { ProviderCredentialsModal } from "../components/provider-credentials-modal";
import { ProviderConfigBadge } from "../components/provider-config-badge";
import { ProviderConfigureButton } from "../components/provider-configure-button";
import { ItemTab } from "./item-tab";
import { providerTabConfig } from "./item-tab-configs";
import type { ProviderConfig, JSONSchemaObject } from "@appstrate/shared-types";

export function ProvidersPage() {
  const { t } = useTranslation(["settings", "flows"]);
  const [showAll, setShowAll] = useState(false);
  const { data: providersData } = useProviders();
  const { data: integrations } = useServices();
  const { isOrgAdmin } = useOrg();

  const connectMutation = useConnect();
  const connectApiKeyMutation = useConnectApiKey();
  const connectCredentialsMutation = useConnectCredentials();
  const disconnectMutation = useDisconnect();

  const [apiKeyProvider, setApiKeyProvider] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [customCredProvider, setCustomCredProvider] = useState<{
    id: string;
    name: string;
    schema: JSONSchemaObject;
  } | null>(null);
  const [configurePickerOpen, setConfigurePickerOpen] = useState(false);
  const [configureProvider, setConfigureProvider] = useState<ProviderConfig | null>(null);

  const connectedProviders = new Set<string>();
  if (integrations) {
    for (const integ of integrations) {
      if (integ.status === "connected") {
        connectedProviders.add(integ.provider);
      }
    }
  }

  const handleConnect = (provider: ProviderConfig) => {
    if (provider.authMode === "api_key") {
      setApiKeyProvider({ id: provider.id, name: provider.displayName });
    } else if (provider.authMode === "custom" && provider.credentialSchema) {
      setCustomCredProvider({
        id: provider.id,
        name: provider.displayName,
        schema: provider.credentialSchema as unknown as JSONSchemaObject,
      });
    } else {
      connectMutation.mutate({ provider: provider.id });
    }
  };

  const handleDisconnect = (providerId: string) => {
    disconnectMutation.mutate({ provider: providerId });
  };

  const isPending =
    connectMutation.isPending ||
    connectApiKeyMutation.isPending ||
    connectCredentialsMutation.isPending ||
    disconnectMutation.isPending;

  // Build lookups: providerId → badge, actions, icon
  const badgeMap = new Map<string, ReactNode>();
  const actionsMap = new Map<string, ReactNode>();
  const iconMap = new Map<string, string>();
  if (providersData?.providers) {
    for (const p of providersData.providers) {
      if (p.iconUrl) iconMap.set(p.id, p.iconUrl);

      badgeMap.set(p.id, <ProviderConfigBadge enabled={p.enabled} />);

      const isConnected = connectedProviders.has(p.id);
      const connectButton =
        p.authMode !== "proxy" ? (
          isConnected ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-emerald-500">{t("services.connected")}</span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => handleDisconnect(p.id)}
                disabled={isPending}
              >
                {t("detail.disconnect", { ns: "flows" })}
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => handleConnect(p)}
              disabled={!p.enabled || isPending}
              title={!p.enabled ? t("providers.notConfigured") : undefined}
            >
              {t("detail.connect", { ns: "flows" })}
            </Button>
          )
        ) : null;

      const configButton = isOrgAdmin ? (
        <ProviderConfigureButton provider={p} callbackUrl={providersData.callbackUrl} />
      ) : null;

      if (connectButton || configButton) {
        actionsMap.set(
          p.id,
          <div className="flex items-center gap-2 ml-auto">
            {connectButton}
            {configButton}
          </div>,
        );
      }
    }
  }

  // Filter: enabled providers (default) or all
  const enabledIds = new Set<string>();
  if (providersData?.providers) {
    for (const p of providersData.providers) {
      if (p.enabled) enabledIds.add(p.id);
    }
  }
  const allProviders = providersData?.providers ?? [];

  const filterToggle = (
    <Tabs value={showAll ? "all" : "enabled"} onValueChange={(v) => setShowAll(v === "all")}>
      <TabsList>
        <TabsTrigger value="enabled">{t("providers.filterEnabled")}</TabsTrigger>
        <TabsTrigger value="all">{t("providers.filterAll")}</TabsTrigger>
      </TabsList>
    </Tabs>
  );

  const configureButton = isOrgAdmin ? (
    <Button
      variant="outline"
      onClick={() => setConfigurePickerOpen(true)}
      disabled={allProviders.length === 0}
    >
      <Settings size={14} />
      {t("providers.configureProvider")}
    </Button>
  ) : null;

  return (
    <>
      <ItemTab
        config={providerTabConfig}
        badgeMap={badgeMap}
        actionsMap={actionsMap}
        iconMap={iconMap}
        filterIds={showAll ? undefined : enabledIds}
        headerContent={filterToggle}
        extraActions={configureButton}
        emptyExtraActions={configureButton}
      />
      <ApiKeyModal
        open={!!apiKeyProvider}
        onClose={() => setApiKeyProvider(null)}
        providerName={apiKeyProvider?.name ?? ""}
        isPending={connectApiKeyMutation.isPending}
        onSubmit={(apiKey) => {
          if (!apiKeyProvider) return;
          connectApiKeyMutation.mutate(
            { provider: apiKeyProvider.id, apiKey },
            { onSuccess: () => setApiKeyProvider(null) },
          );
        }}
      />
      {customCredProvider && (
        <CustomCredentialsModal
          open
          onClose={() => setCustomCredProvider(null)}
          schema={customCredProvider.schema}
          serviceId={customCredProvider.id}
          serviceName={customCredProvider.name}
          isPending={connectCredentialsMutation.isPending}
          onSubmit={(credentials) => {
            connectCredentialsMutation.mutate(
              { provider: customCredProvider.id, credentials },
              { onSuccess: () => setCustomCredProvider(null) },
            );
          }}
        />
      )}
      <Modal
        open={configurePickerOpen}
        onClose={() => setConfigurePickerOpen(false)}
        title={t("providers.configureProvider")}
      >
        <p className="text-sm text-muted-foreground mb-4">{t("providers.selectProvider")}</p>
        {allProviders.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            {t("providers.allConfigured")}
          </p>
        ) : (
          <div className="space-y-1">
            {allProviders.map((p) => (
              <button
                key={p.id}
                type="button"
                className="w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-muted/50 transition-colors"
                onClick={() => {
                  setConfigurePickerOpen(false);
                  setConfigureProvider(p);
                }}
              >
                {p.iconUrl ? (
                  <img src={p.iconUrl} alt="" className="w-6 h-6 rounded" />
                ) : (
                  <div className="w-6 h-6 rounded bg-muted flex items-center justify-center text-xs font-medium text-muted-foreground">
                    {p.displayName.charAt(0).toUpperCase()}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium">{p.displayName}</span>
                </div>
                <ProviderConfigBadge enabled={p.enabled} />
              </button>
            ))}
          </div>
        )}
      </Modal>
      {configureProvider && (
        <ProviderCredentialsModal
          provider={configureProvider}
          callbackUrl={providersData?.callbackUrl}
          onClose={() => setConfigureProvider(null)}
        />
      )}
    </>
  );
}
