import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { type LucideIcon, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFlows, usePackageList } from "../hooks/use-packages";
import { useProviders } from "../hooks/use-providers";
import { useServices } from "../hooks/use-services";
import { useOrg } from "../hooks/use-org";
import {
  useConnect,
  useConnectApiKey,
  useConnectCredentials,
  useDisconnect,
} from "../hooks/use-mutations";
import { ImportModal } from "../components/import-modal";
import { ApiKeyModal } from "../components/api-key-modal";
import { CustomCredentialsModal } from "../components/custom-credentials-modal";
import { PackageCard } from "../components/package-card";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { Modal } from "../components/modal";
import { ProviderCredentialsModal } from "../components/provider-credentials-modal";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import { Settings } from "lucide-react";
import type { ProviderConfig, JSONSchemaObject } from "@appstrate/shared-types";

type TabType = "flows" | "skills" | "extensions" | "providers";

interface CardItem {
  id: string;
  displayName: string;
  description?: string | null;
  type: "flow" | "skill" | "extension" | "provider";
  source?: "built-in" | "local";
  runningExecutions?: number;
  tags?: string[];
  usedByFlows?: number;
  statusBadge?: ReactNode;
  actions?: ReactNode;
  iconUrl?: string;
  autoInstalled?: boolean;
}

interface PackageTabProps {
  items: CardItem[] | undefined;
  isLoading: boolean;
  error?: Error | null;
  emptyMessage: string;
  emptyHint: string;
  emptyIcon?: LucideIcon;
  extraActions?: ReactNode;
  headerContent?: ReactNode;
}

function PackageTab({
  items,
  isLoading,
  error,
  emptyMessage,
  emptyHint,
  emptyIcon,
  extraActions,
  headerContent,
}: PackageTabProps) {
  const { t } = useTranslation(["flows"]);
  const { isOrgAdmin } = useOrg();
  const [importOpen, setImportOpen] = useState(false);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  const importButton = (
    <Button variant="outline" onClick={() => setImportOpen(true)}>
      {t("list.import")}
    </Button>
  );

  const header = (
    <div className="flex items-center justify-between gap-2 mb-4">
      <div>{headerContent}</div>
      <div className="flex items-center gap-2">
        {isOrgAdmin && extraActions}
        {importButton}
      </div>
    </div>
  );

  const modal = <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />;

  if (!items || items.length === 0) {
    return (
      <>
        {header}
        <EmptyState message={emptyMessage} hint={emptyHint} icon={emptyIcon}>
          {isOrgAdmin && extraActions}
          {importButton}
        </EmptyState>
        {modal}
      </>
    );
  }

  return (
    <>
      {header}
      <div className="grid gap-3 grid-cols-1 md:grid-cols-2">
        {items.map((item) => (
          <PackageCard key={item.id} {...item} />
        ))}
      </div>
      {modal}
    </>
  );
}

function FlowsTab() {
  const { t } = useTranslation(["flows", "common"]);
  const { data: flows, isLoading, error } = useFlows();
  const { isOrgAdmin } = useOrg();

  const items: CardItem[] | undefined = flows?.map((f) => ({
    id: f.id,
    displayName: f.displayName,
    description: f.description,
    type: "flow",
    source: f.source,
    runningExecutions: f.runningExecutions,
    tags: f.tags,
  }));

  return (
    <PackageTab
      items={items}
      isLoading={isLoading}
      error={error}
      emptyMessage={t("list.empty")}
      emptyHint={t("list.emptyHint")}
      emptyIcon={Layers}
      extraActions={
        isOrgAdmin ? (
          <Link to="/flows/new">
            <Button>{t("list.create")}</Button>
          </Link>
        ) : undefined
      }
    />
  );
}

interface ItemTabConfig {
  type: "skill" | "extension" | "provider";
  useData: () => {
    data:
      | {
          id: string;
          name?: string | null;
          description?: string | null;
          source?: "built-in" | "local";
          usedByFlows?: number;
          autoInstalled?: boolean;
        }[]
      | undefined;
    isLoading: boolean;
  };
  emptyMessageKey: string;
  emptyHintKey: string;
}

const ITEM_TAB_CONFIGS: ItemTabConfig[] = [
  {
    type: "skill",
    useData: () => usePackageList("skill"),
    emptyMessageKey: "packages.emptyItems",
    emptyHintKey: "packages.emptyItemsHint",
  },
  {
    type: "extension",
    useData: () => usePackageList("extension"),
    emptyMessageKey: "packages.emptyItems",
    emptyHintKey: "packages.emptyItemsHint",
  },
  {
    type: "provider",
    useData: () => usePackageList("provider"),
    emptyMessageKey: "packages.emptyItems",
    emptyHintKey: "packages.emptyItemsHint",
  },
];

function ItemTab({
  config,
  badgeMap,
  actionsMap,
  iconMap,
  filterIds,
  headerContent,
  extraActions: externalActions,
}: {
  config: ItemTabConfig;
  badgeMap?: Map<string, ReactNode>;
  actionsMap?: Map<string, ReactNode>;
  iconMap?: Map<string, string>;
  filterIds?: Set<string>;
  headerContent?: ReactNode;
  extraActions?: ReactNode;
}) {
  const { t } = useTranslation(["settings", "flows", "common"]);
  const { isOrgAdmin } = useOrg();
  const { data: rawItems, isLoading } = config.useData();

  const typeLabel = t(`packages.type.${config.type}`);
  const filtered = filterIds ? rawItems?.filter((item) => filterIds.has(item.id)) : rawItems;
  const items: CardItem[] | undefined = filtered?.map((item) => ({
    id: item.id,
    displayName: item.name || item.id,
    description: item.description,
    type: config.type,
    source: item.source,
    usedByFlows: item.usedByFlows,
    statusBadge: badgeMap?.get(item.id),
    actions: actionsMap?.get(item.id),
    iconUrl: iconMap?.get(item.id),
    autoInstalled: item.autoInstalled,
  }));

  return (
    <PackageTab
      items={items}
      isLoading={isLoading}
      emptyMessage={t(config.emptyMessageKey, { type: typeLabel })}
      emptyHint={t(config.emptyHintKey, { type: typeLabel })}
      extraActions={
        isOrgAdmin ? (
          <>
            {externalActions}
            <Link to={`/${config.type}s/new`}>
              <Button>{t("list.createItem", { ns: "flows" })}</Button>
            </Link>
          </>
        ) : undefined
      }
      headerContent={headerContent}
    />
  );
}

const skillTabConfig = ITEM_TAB_CONFIGS[0];
const extensionTabConfig = ITEM_TAB_CONFIGS[1];
const providerTabConfig = ITEM_TAB_CONFIGS[2];

function ProviderConnectButton({
  isConnected,
  disabled,
  onConnect,
  onDisconnect,
  isPending,
}: {
  isConnected: boolean;
  disabled: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  isPending: boolean;
}) {
  const { t } = useTranslation(["settings", "flows"]);

  if (isConnected) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-emerald-500">{t("services.connected")}</span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={onDisconnect}
          disabled={isPending}
        >
          {t("detail.disconnect", { ns: "flows" })}
        </Button>
      </div>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 px-2 text-xs"
      onClick={onConnect}
      disabled={disabled || isPending}
      title={disabled ? t("providers.notConfigured") : undefined}
    >
      {t("detail.connect", { ns: "flows" })}
    </Button>
  );
}

function ProvidersTab() {
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

  // Build a lookup: providerId → connected status
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
      // Icon
      if (p.iconUrl) {
        iconMap.set(p.id, p.iconUrl);
      }

      // Credential status badge (admin config)
      badgeMap.set(
        p.id,
        p.enabled ? (
          <span className="text-[0.65rem] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500 font-medium">
            {t("providers.configured")}
          </span>
        ) : (
          <span className="text-[0.65rem] px-1.5 py-0.5 rounded bg-warning/10 text-warning font-medium">
            {t("providers.notConfigured")}
          </span>
        ),
      );

      // Connection button (user-level)
      // Proxy providers don't have user connections
      if (p.authMode !== "proxy") {
        const isConnected = connectedProviders.has(p.id);
        const needsAdminConfig = !p.enabled;
        actionsMap.set(
          p.id,
          <ProviderConnectButton
            isConnected={isConnected}
            disabled={needsAdminConfig}
            onConnect={() => handleConnect(p)}
            onDisconnect={() => handleDisconnect(p.id)}
            isPending={isPending}
          />,
        );
      }
    }
  }

  // Filter: enabled providers (default) or all
  const enabledIds = new Set<string>();
  if (providersData?.providers) {
    for (const p of providersData.providers) {
      if (p.enabled) {
        enabledIds.add(p.id);
      }
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
                {p.enabled ? (
                  <span className="text-[0.65rem] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500 font-medium">
                    {t("providers.configured")}
                  </span>
                ) : (
                  <span className="text-[0.65rem] px-1.5 py-0.5 rounded bg-warning/10 text-warning font-medium">
                    {t("providers.notConfigured")}
                  </span>
                )}
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

export function PackageList() {
  const { t } = useTranslation(["flows", "settings", "common"]);
  const [tab, setTab] = useTabWithHash<TabType>(
    ["flows", "skills", "extensions", "providers"],
    "flows",
  );

  return (
    <>
      <Tabs value={tab} onValueChange={(v) => setTab(v as TabType)}>
        <TabsList>
          <TabsTrigger value="flows">{t("list.tabFlows", { ns: "flows" })}</TabsTrigger>
          <TabsTrigger value="skills">{t("list.tabSkills", { ns: "flows" })}</TabsTrigger>
          <TabsTrigger value="extensions">{t("list.tabExtensions", { ns: "flows" })}</TabsTrigger>
          <TabsTrigger value="providers">{t("list.tabProviders", { ns: "flows" })}</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="mt-4">
        {tab === "flows" && <FlowsTab />}
        {tab === "skills" && <ItemTab config={skillTabConfig} />}
        {tab === "extensions" && <ItemTab config={extensionTabConfig} />}
        {tab === "providers" && <ProvidersTab />}
      </div>
    </>
  );
}
