import { useTranslation } from "react-i18next";
import { Unplug } from "lucide-react";
import { EmptyState } from "../page-states";
import { usePackageDetail } from "../../hooks/use-packages";
import { useOrg } from "../../hooks/use-org";
import { computeProvidersSummary } from "../../lib/provider-status";
import { ProviderConnectionCard } from "../provider-connection-card";

export function FlowProvidersSection({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["flows"]);
  const { isOrgAdmin } = useOrg();
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
  const summary = computeProvidersSummary(detail.dependencies.providers, t);

  return (
    <>
      {summary && (
        <div className="text-sm text-muted-foreground mb-3">
          {summary.connectedCount > 0 &&
            t("detail.providersSummaryOk", { connected: summary.connectedCount })}
          {summary.connectedCount > 0 && summary.actionCount > 0 && " — "}
          {summary.actionCount > 0 && (
            <span className="text-warning font-medium">
              {t("detail.providersSummaryAction", { count: summary.actionCount })}
            </span>
          )}
        </div>
      )}

      <div className="space-y-2 mb-4">
        {detail.dependencies.providers.map((svc) => {
          const isOrgBound = svc.source === "org_binding";

          if (isOrgAdmin) {
            return (
              <ProviderConnectionCard
                key={svc.id}
                providerId={svc.id}
                orgProfileId={flowOrgProfileId ?? undefined}
                orgProfileName={flowOrgProfileName ?? undefined}
              />
            );
          }

          if (isOrgBound) {
            return (
              <ProviderConnectionCard
                key={svc.id}
                providerId={svc.id}
                orgProfileId={flowOrgProfileId ?? undefined}
                orgProfileName={flowOrgProfileName ?? undefined}
                readOnly
              />
            );
          }

          return <ProviderConnectionCard key={svc.id} providerId={svc.id} />;
        })}
      </div>
    </>
  );
}
