// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Building2, AlertTriangle } from "lucide-react";
import { Badge as UIBadge } from "@/components/ui/badge";
import { ProviderConnectionCard } from "./provider-connection-card";
import { useAppProfileBindings } from "../hooks/use-connection-profiles";

interface AppProfileProvidersBlockProps {
  /** App profile ID */
  appProfileId: string;
  /** App profile display name */
  appProfileName: string;
  /** Provider IDs to display */
  providerIds: string[];
}

/**
 * Shared block showing an app profile header + provider connection cards.
 * Used by schedule detail (providers tab).
 */
export function AppProfileProvidersBlock({
  appProfileId,
  appProfileName,
  providerIds,
}: AppProfileProvidersBlockProps) {
  const { t } = useTranslation(["agents"]);
  const { data: bindings } = useAppProfileBindings(appProfileId);

  if (providerIds.length === 0) return null;

  const hasUnboundProviders =
    bindings !== undefined &&
    providerIds.some((pid) => !bindings.find((b) => b.providerId === pid && b.connected));

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
        <span className="text-muted-foreground ml-auto text-xs">
          {t("detail.orgProvidersHint")}
        </span>
      </div>

      <div className="space-y-2 p-2">
        {providerIds.map((providerId) => (
          <ProviderConnectionCard
            key={providerId}
            providerId={providerId}
            appProfileId={appProfileId}
            appProfileName={appProfileName}
          />
        ))}
      </div>
    </div>
  );
}
