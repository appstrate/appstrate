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
    <div className="border-border bg-card mb-4 rounded-lg border">
      {hasUnboundProviders && (
        <div className="bg-warning/10 border-warning/30 flex items-start gap-2 border-b px-4 py-3">
          <AlertTriangle className="text-warning mt-0.5 size-4 shrink-0" />
          <p className="text-warning text-xs">{t("schedule.providersNotBoundWarning")}</p>
        </div>
      )}
      <div className="border-border flex items-center gap-2 border-b px-4 py-3">
        <Building2 className="text-muted-foreground size-4" />
        <span className="text-sm font-medium">{orgProfileName}</span>
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
            orgProfileId={orgProfileId}
            orgProfileName={orgProfileName}
          />
        ))}
      </div>
    </div>
  );
}
