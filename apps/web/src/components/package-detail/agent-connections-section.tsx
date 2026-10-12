// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Unplug } from "lucide-react";
import { EmptyState } from "../page-states";
import { AgentIntegrationsBlock } from "./agent-integrations-block";
import type { AgentDetail } from "@appstrate/shared-types";

interface AgentConnectionsSectionProps {
  packageId: string;
  detail: AgentDetail;
}

/** Agent "Connexions" tab: the integrations the agent declares, each with its connection picker. */
export function AgentConnectionsSection({ packageId, detail }: AgentConnectionsSectionProps) {
  const { t } = useTranslation(["agents"]);

  const integrations = detail.dependencies.integrations;
  const hasIntegrations = integrations.length > 0;

  if (!hasIntegrations) {
    return (
      <EmptyState
        message={t("detail.emptyConnections")}
        hint={t("detail.emptyConnectionsHint")}
        icon={Unplug}
        compact
      />
    );
  }

  return <AgentIntegrationsBlock entries={integrations} agentPackageId={packageId} />;
}
