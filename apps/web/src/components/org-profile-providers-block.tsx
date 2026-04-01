import { useTranslation } from "react-i18next";
import { Building2, AlertTriangle } from "lucide-react";
import { Badge as UIBadge } from "@/components/ui/badge";
import { ProviderConnectionCard } from "./provider-connection-card";
import { useOrgProfileBindings } from "../hooks/use-connection-profiles";

interface OrgProfileProvidersBlockProps {
  /** Org profile ID */
  orgProfileId: string;
  /** Org profile display name */
  orgProfileName: string;
  /** Provider IDs to display */
  providerIds: string[];
}

/**
 * Shared block showing an org profile header + provider connection cards.
 * Used by schedule detail (providers tab).
 */
export function OrgProfileProvidersBlock({
  orgProfileId,
  orgProfileName,
  providerIds,
}: OrgProfileProvidersBlockProps) {
  const { t } = useTranslation(["flows"]);
  const { data: bindings } = useOrgProfileBindings(orgProfileId);

  if (providerIds.length === 0) return null;

  const hasUnboundProviders =
    bindings !== undefined &&
    providerIds.some((pid) => !bindings.find((b) => b.providerId === pid && b.connected));

  return (
    <div className="rounded-lg border border-border bg-card mb-4">
      {hasUnboundProviders && (
        <div className="flex items-start gap-2 px-4 py-3 bg-warning/10 border-b border-warning/30">
          <AlertTriangle className="size-4 shrink-0 mt-0.5 text-warning" />
          <p className="text-xs text-warning">{t("schedule.providersNotBoundWarning")}</p>
        </div>
      )}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Building2 className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">{orgProfileName}</span>
        <UIBadge variant="outline" className="text-[10px] px-1 py-0">
          {t("providerCard.orgBadge", { ns: "settings" })}
        </UIBadge>
        <span className="text-xs text-muted-foreground ml-auto">
          {t("detail.orgProvidersHint")}
        </span>
      </div>

      <div className="p-2 space-y-2">
        {providerIds.map((providerId) => (
          <ProviderConnectionCard
            key={providerId}
            providerId={providerId}
            orgProfileId={orgProfileId}
            orgProfileName={orgProfileName}
          />
        ))}
      </div>
    </div>
  );
}
