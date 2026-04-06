// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Unplug } from "lucide-react";
import { EmptyState } from "../page-states";
import { usePackageDetail } from "../../hooks/use-packages";
import { ProviderConnectionCard } from "../provider-connection-card";
import { AppProfileProvidersBlock } from "../app-profile-providers-block";
import type { AgentDetail } from "@appstrate/shared-types";

interface AgentProvidersSectionProps {
  packageId: string;
  /** When provided, skips the redundant fetch (detail already loaded by parent). */
  detail?: AgentDetail;
}

export function AgentProvidersSection({
  packageId,
  detail: providedDetail,
}: AgentProvidersSectionProps) {
  const { t } = useTranslation(["agents"]);
  const { data: fetchedDetail } = usePackageDetail("agent", packageId);

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

  const { agentAppProfileId, agentAppProfileName } = detail;

  if (agentAppProfileId && agentAppProfileName) {
    return (
      <AppProfileProvidersBlock
        appProfileId={agentAppProfileId}
        appProfileName={agentAppProfileName}
        providers={detail.dependencies.providers}
        packageId={packageId}
      />
    );
  }

  return (
    <div className="mb-4 space-y-2">
      {detail.dependencies.providers.map((svc) => (
        <ProviderConnectionCard
          key={svc.id}
          providerId={svc.id}
          packageId={packageId}
          scopesRequired={svc.scopesRequired}
          scopesMissing={svc.scopesMissing}
        />
      ))}
    </div>
  );
}
