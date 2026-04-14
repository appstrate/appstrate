// SPDX-License-Identifier: Apache-2.0

import { useState, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useProviders } from "../hooks/use-providers";
import { useConnectionProfiles } from "../hooks/use-connection-profiles";
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
  const { t } = useTranslation(["settings", "agents"]);
  const [showAll, setShowAll] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const { data: profiles } = useConnectionProfiles();
  const { data: providersData } = useProviders();

  // Resolve effective profile: user selection → default profile → first profile
  const profileId = useMemo(() => {
    if (selectedProfileId) return selectedProfileId;
    if (!profiles?.length) return null;
    return (profiles.find((p) => p.isDefault) ?? profiles[0])?.id ?? null;
  }, [selectedProfileId, profiles]);

  const [configurePickerOpen, setConfigurePickerOpen] = useState(false);
  const [configureProvider, setConfigureProvider] = useState<ProviderConfig | null>(null);

  // Build lookups: providerId → badge, actions, icon
  const { badgeMap, actionsMap, iconMap } = useMemo(() => {
    const badges = new Map<string, ReactNode>();
    const actions = new Map<string, ReactNode>();
    const icons = new Map<string, string>();
    if (providersData?.providers) {
      for (const p of providersData.providers) {
        if (p.iconUrl) icons.set(p.id, p.iconUrl);

        badges.set(p.id, <ProviderConfigBadge enabled={p.enabled} />);

        const configButton = (
          <ProviderConfigureButton provider={p} callbackUrl={providersData.callbackUrl} />
        );

        actions.set(
          p.id,
          <div className="ml-auto flex items-center gap-2">
            <ProviderConnectButton provider={p} profileId={profileId} />
            {configButton}
          </div>,
        );
      }
    }
    return { badgeMap: badges, actionsMap: actions, iconMap: icons };
  }, [providersData, profileId]);

  // Filter: enabled providers (default) or all
  const enabledIds = new Set<string>();
  if (providersData?.providers) {
    for (const p of providersData.providers) {
      if (p.enabled) enabledIds.add(p.id);
    }
  }
  const allProviders = providersData?.providers ?? [];

  const filterToggle = (
    <div className="mt-2 flex items-center gap-3">
      <Tabs value={showAll ? "all" : "enabled"} onValueChange={(v) => setShowAll(v === "all")}>
        <TabsList>
          <TabsTrigger value="enabled">{t("providers.filterEnabled")}</TabsTrigger>
          <TabsTrigger value="all">{t("providers.filterAll")}</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="flex-1" />
      <ProfileSelector value={profileId} onChange={setSelectedProfileId} />
    </div>
  );

  const configureButton = (
    <Button
      variant="outline"
      onClick={() => setConfigurePickerOpen(true)}
      disabled={allProviders.length === 0}
    >
      <Settings size={14} />
      {t("providers.configureProvider")}
    </Button>
  );

  return (
    <div className="p-6">
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
        <p className="text-muted-foreground mb-4 text-sm">{t("providers.selectProvider")}</p>
        {allProviders.length === 0 ? (
          <p className="text-muted-foreground py-4 text-center text-sm">
            {t("providers.allConfigured")}
          </p>
        ) : (
          <div className="space-y-1">
            {allProviders.map((p) => (
              <button
                key={p.id}
                type="button"
                className="hover:bg-muted/50 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors"
                onClick={() => {
                  setConfigurePickerOpen(false);
                  setConfigureProvider(p);
                }}
              >
                {p.iconUrl ? (
                  <ProviderIcon src={p.iconUrl} className="h-6 w-6" />
                ) : (
                  <div className="bg-muted text-muted-foreground flex h-6 w-6 items-center justify-center rounded text-xs font-medium">
                    {p.displayName.charAt(0).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium">{p.displayName}</span>
                </div>
                <ProviderConfigBadge enabled={p.enabled} />
              </button>
            ))}
          </div>
        )}
        <div className="border-border mt-4 border-t pt-3">
          <Link
            to="/providers/new"
            className="text-muted-foreground hover:text-foreground hover:bg-muted/50 flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium no-underline transition-colors"
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
    </div>
  );
}
