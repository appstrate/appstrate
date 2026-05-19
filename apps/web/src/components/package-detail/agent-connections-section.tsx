// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Unplug } from "lucide-react";
import { EmptyState } from "../page-states";
import { usePackageDetail } from "../../hooks/use-packages";
import { ProviderConnectionCard } from "../provider-connection-card";
import { AppProfileProvidersBlock } from "../app-profile-providers-block";
import { AgentIntegrationsBlock } from "./agent-integrations-block";
import type { AgentDetail } from "@appstrate/shared-types";

interface AgentConnectionsSectionProps {
  packageId: string;
  /** When provided, skips the redundant fetch (detail already loaded by parent). */
  detail?: AgentDetail;
}

/**
 * Phase B.2 — unified "Connexions" tab: providers (existing) +
 * integrations (Phase B.1). The two surfaces share the tab because they
 * both gate `Run` via the same `validateAgentReadiness` pipeline on the
 * backend; collapsing them here keeps the user's mental model in one
 * place ("everything I need to connect before this agent works").
 */
export function AgentConnectionsSection({
  packageId,
  detail: providedDetail,
}: AgentConnectionsSectionProps) {
  const { t } = useTranslation(["agents"]);
  const { data: fetchedDetail } = usePackageDetail("agent", packageId);

  const detail = providedDetail ?? fetchedDetail;
  if (!detail) return null;

  const providers = detail.dependencies.providers;
  const integrations = detail.dependencies.integrations ?? [];
  const hasProviders = providers.length > 0;
  const hasIntegrations = integrations.length > 0;

  if (!hasProviders && !hasIntegrations) {
    return (
      <EmptyState
        message={t("detail.emptyConnections")}
        hint={t("detail.emptyConnectionsHint")}
        icon={Unplug}
        compact
      />
    );
  }

  const { agentAppProfileId, agentAppProfileName } = detail;

  return (
    <div className="space-y-6">
      {hasProviders && (
        <section className="space-y-2">
          {hasIntegrations && (
            <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
              {t("detail.providersSectionTitle")}
            </h3>
          )}
          {agentAppProfileId && agentAppProfileName ? (
            <AppProfileProvidersBlock
              appProfileId={agentAppProfileId}
              appProfileName={agentAppProfileName}
              providers={providers}
              packageId={packageId}
            />
          ) : (
            <div className="space-y-2">
              {providers.map((svc) => (
                <ProviderConnectionCard
                  key={svc.id}
                  providerId={svc.id}
                  packageId={packageId}
                  scopesRequired={svc.scopesRequired}
                  scopesMissing={svc.scopesMissing}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {hasIntegrations && (
        <section className="space-y-2">
          {hasProviders && (
            <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
              {t("detail.integrationsSectionTitle")}
            </h3>
          )}
          <AgentIntegrationsBlock entries={integrations} agentPackageId={packageId} />
        </section>
      )}
    </div>
  );
}
