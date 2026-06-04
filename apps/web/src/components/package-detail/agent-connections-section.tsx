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

/**
 * Agent "Connexions" tab — lists the integrations the agent declares and
 * gates `Run` via the same `validateAgentReadiness` pipeline on the
 * backend.
 */
export function AgentConnectionsSection({ packageId, detail }: AgentConnectionsSectionProps) {
  const { t } = useTranslation(["agents"]);

  const integrations = detail.dependencies.integrations ?? [];
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

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <AgentIntegrationsBlock entries={integrations} agentPackageId={packageId} />
      </section>
    </div>
  );
}
