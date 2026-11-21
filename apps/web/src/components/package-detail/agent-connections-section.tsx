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

/** Agent "Connexions" tab: the integrations the agent declares that bind a connection, each with its picker. */
export function AgentConnectionsSection({ packageId, detail }: AgentConnectionsSectionProps) {
  const { t } = useTranslation(["agents"]);

  return (
    <AgentIntegrationsBlock
      entries={detail.dependencies.integrations}
      agentPackageId={packageId}
      empty={
        <EmptyState
          message={t("detail.emptyConnections")}
          hint={t("detail.emptyConnectionsHint")}
          icon={Unplug}
          compact
        />
      }
    />
  );
}
