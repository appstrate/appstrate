// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Building2, AlertTriangle } from "lucide-react";
import { Badge as UIBadge } from "@/components/ui/badge";
import { ProviderConnectionCard } from "./provider-connection-card";
import { useAppProfileBindings } from "../hooks/use-connection-profiles";

export interface ProviderEntry {
  id: string;
  scopesRequired?: string[];
  scopesMissing?: string[];
}

interface AppProfileProvidersBlockProps {
  /** App profile ID */
  appProfileId: string;
  /** App profile display name */
  appProfileName: string;
  /** Providers to display — either simple IDs or rich entries with scope info */
  providers: string[] | ProviderEntry[];
  /** Agent package ID (enables per-provider profile overrides) */
  packageId?: string;
}

/**
 * Shared block showing an app profile header + provider connection cards.
 * Used by schedule detail (providers tab) and agent connectors tab.
 */
export function AppProfileProvidersBlock({
  appProfileId,
  appProfileName,
  providers,
  packageId,
}: AppProfileProvidersBlockProps) {
  const { t } = useTranslation(["agents"]);
  const { data: bindings } = useAppProfileBindings(appProfileId);

  if (providers.length === 0) return null;

  const entries: ProviderEntry[] =
    typeof providers[0] === "string"
      ? (providers as string[]).map((id) => ({ id }))
      : (providers as ProviderEntry[]);

  const hasUnboundProviders =
    bindings !== undefined &&
    entries.some((e) => !bindings.find((b) => b.providerId === e.id && b.connected));

  return (
    <div className="border-border bg-card mb-4 rounded-lg border">
      {hasUnboundProviders && (
        <div className="bg-warning/10 border-warning/30 flex items-start gap-2 border-b px-4 py-3">
          <AlertTriangle className="text-warning mt-0.5 size-4 shrink-0" />
          <p className="text-warning text-xs">{t("schedule.providersNotBoundWarning")}</p>
        </div>
      )}
      <div className="border-border flex items-center gap-2 border-b px-4 py-3">
        <Building2 className="text-muted-foreground size-4" />
        <span className="text-sm font-medium">{appProfileName}</span>
        <UIBadge variant="outline" className="px-1 py-0 text-[10px]">
          {t("providerCard.orgBadge", { ns: "settings" })}
        </UIBadge>
      </div>

      <div className="space-y-2 p-2">
        {entries.map((entry) => (
          <ProviderConnectionCard
            key={entry.id}
            providerId={entry.id}
            packageId={packageId}
            appProfileId={appProfileId}
            appProfileName={appProfileName}
            scopesRequired={entry.scopesRequired}
            scopesMissing={entry.scopesMissing}
          />
        ))}
      </div>
    </div>
  );
}
