// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { AgentDetail } from "@appstrate/shared-types";
import type { JSONSchemaObject } from "@appstrate/core/form";
import { AgentConfigurationTab } from "../package-detail/agent-configuration-tab";
import { AgentConnectionsSection } from "../package-detail/agent-connections-section";
import { AgentSchedulesTab } from "../package-detail/agent-tabs";

function ConfigurationSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="border-border border-b pb-2">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-muted-foreground mt-0.5 text-sm">{description}</p>
      </div>
      {children}
    </section>
  );
}

export function AgentConfigurationView({
  packageId,
  detail,
  configSchemaOverride,
  isHistorical,
}: {
  packageId: string;
  detail: AgentDetail;
  configSchemaOverride?: JSONSchemaObject;
  isHistorical?: boolean;
}) {
  const { t } = useTranslation("agents");
  return (
    <div className="space-y-8" data-agent-configuration>
      <ConfigurationSection
        title={t("detail.configuration.defaults")}
        description={t("detail.configuration.defaultsDescription")}
      >
        <AgentConfigurationTab
          packageId={packageId}
          configSchemaOverride={isHistorical ? configSchemaOverride : detail.input?.schema}
          isHistorical={isHistorical}
        />
      </ConfigurationSection>
      <ConfigurationSection
        title={t("detail.configuration.connections")}
        description={t("detail.configuration.connectionsDescription")}
      >
        {isHistorical ? (
          <p className="text-muted-foreground text-sm">
            {t("detail.configuration.historicalUnavailable")}
          </p>
        ) : (
          <AgentConnectionsSection packageId={packageId} detail={detail} />
        )}
      </ConfigurationSection>
      <ConfigurationSection
        title={t("detail.configuration.schedules")}
        description={t("detail.configuration.schedulesDescription")}
      >
        {isHistorical ? (
          <p className="text-muted-foreground text-sm">
            {t("detail.configuration.historicalUnavailable")}
          </p>
        ) : (
          <AgentSchedulesTab packageId={packageId} />
        )}
      </ConfigurationSection>
    </div>
  );
}
