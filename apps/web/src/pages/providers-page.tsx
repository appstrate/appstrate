import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useProviders } from "../hooks/use-providers";
import { useOrg } from "../hooks/use-org";
import { ProfileSelector } from "../components/profile-selector";
import { Modal } from "../components/modal";
import { ProviderCredentialsModal } from "../components/provider-credentials-modal";
import { ProviderConfigBadge } from "../components/provider-config-badge";
import { ProviderConfigureButton } from "../components/provider-configure-button";
import { ProviderConnectButton } from "../components/provider-connect-button";
import { ItemTab } from "./item-tab";
import { providerTabConfig } from "./item-tab-configs";
import { ProviderIcon } from "../components/provider-icon";
import type { ProviderConfig } from "@appstrate/shared-types";

export function ProvidersPage() {
  const { t } = useTranslation(["settings", "flows"]);
  const [showAll, setShowAll] = useState(false);
  const [profileId, setProfileId] = useState<string | null>(null);
  const { data: providersData } = useProviders();
  const { isOrgAdmin } = useOrg();

  const [configurePickerOpen, setConfigurePickerOpen] = useState(false);
  const [configureProvider, setConfigureProvider] = useState<ProviderConfig | null>(null);

  // Build lookups: providerId → badge, actions, icon
  const badgeMap = new Map<string, ReactNode>();
  const actionsMap = new Map<string, ReactNode>();
  const iconMap = new Map<string, string>();
  if (providersData?.providers) {
    for (const p of providersData.providers) {
      if (p.iconUrl) iconMap.set(p.id, p.iconUrl);

      badgeMap.set(p.id, <ProviderConfigBadge enabled={p.enabled} />);

      const configButton = isOrgAdmin ? (
        <ProviderConfigureButton provider={p} callbackUrl={providersData.callbackUrl} />
      ) : null;

      actionsMap.set(
        p.id,
        <div className="flex items-center gap-2 ml-auto">
          <ProviderConnectButton provider={p} />
          {configButton}
        </div>,
      );
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
    <div className="flex items-center gap-3 mt-2">
      <Tabs value={showAll ? "all" : "enabled"} onValueChange={(v) => setShowAll(v === "all")}>
        <TabsList>
          <TabsTrigger value="enabled">{t("providers.filterEnabled")}</TabsTrigger>
          <TabsTrigger value="all">{t("providers.filterAll")}</TabsTrigger>
        </TabsList>
      </Tabs>
      <ProfileSelector value={profileId} onChange={setProfileId} />
    </div>
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
                  <ProviderIcon src={p.iconUrl} className="w-6 h-6" />
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
        <div className="mt-4 pt-3 border-t border-border">
          <Link
            to="/providers/new"
            className="flex items-center justify-center gap-2 w-full rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors no-underline"
          >
            <span className="text-lg leading-none">+</span>
            {t("providers.newProvider")}
          </Link>
        </div>
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
