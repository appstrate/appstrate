import { useTranslation } from "react-i18next";
import { Unplug } from "lucide-react";
import { EmptyState } from "../page-states";
import { usePackageDetail } from "../../hooks/use-packages";
import { ProviderConnectionCard } from "../provider-connection-card";

export function FlowProvidersSection({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["flows"]);
  const { data: detail } = usePackageDetail("flow", packageId);

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

  const flowOrgProfileId = detail.flowOrgProfileId;
  const flowOrgProfileName = detail.flowOrgProfileName;

  return (
    <div className="space-y-2 mb-4">
      {detail.dependencies.providers.map((svc) => (
        <ProviderConnectionCard
          key={svc.id}
          providerId={svc.id}
          packageId={packageId}
          orgProfileId={flowOrgProfileId ?? undefined}
          orgProfileName={flowOrgProfileName ?? undefined}
        />
      ))}
    </div>
  );
}
