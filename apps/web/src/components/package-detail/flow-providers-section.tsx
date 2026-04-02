// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Unplug } from "lucide-react";
import { EmptyState } from "../page-states";
import { usePackageDetail } from "../../hooks/use-packages";
import { ProviderConnectionCard } from "../provider-connection-card";
import type { FlowDetail } from "@appstrate/shared-types";

interface FlowProvidersSectionProps {
  packageId: string;
  /** When provided, skips the redundant fetch (detail already loaded by parent). */
  detail?: FlowDetail;
}

export function FlowProvidersSection({
  packageId,
  detail: providedDetail,
}: FlowProvidersSectionProps) {
  const { t } = useTranslation(["flows"]);
  const { data: fetchedDetail } = usePackageDetail("flow", packageId);

  const detail = providedDetail ?? fetchedDetail;

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
    <div className="mb-4 space-y-2">
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
