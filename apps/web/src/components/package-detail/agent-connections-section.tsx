// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Unplug } from "lucide-react";
import { EmptyState } from "../page-states";
import { usePackageDetail } from "../../hooks/use-packages";
import { AgentIntegrationsBlock } from "./agent-integrations-block";
import type { AgentDetail } from "@appstrate/shared-types";

interface AgentConnectionsSectionProps {
  packageId: string;
  /** When provided, skips the redundant fetch (detail already loaded by parent). */
  detail?: AgentDetail;
}

/**
 * Agent "Connexions" tab — lists the integrations the agent declares and
 * gates `Run` via the same `validateAgentReadiness` pipeline on the
 * backend.
 */
export function AgentConnectionsSection({
  packageId,
  detail: providedDetail,
}: AgentConnectionsSectionProps) {
  const { t } = useTranslation(["agents"]);
  const { data: fetchedDetail } = usePackageDetail("agent", packageId);

  const detail = providedDetail ?? fetchedDetail;
  if (!detail) return null;

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
