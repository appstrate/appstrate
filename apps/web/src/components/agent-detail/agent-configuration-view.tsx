// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { AgentDetail } from "@appstrate/shared-types";
import type { JSONSchemaObject } from "@appstrate/core/form";
import { AgentConfigurationTab } from "../package-detail/agent-configuration-tab";
import { AgentConnectionsSection } from "../package-detail/agent-connections-section";
import { AgentSchedulesTab } from "../package-detail/agent-tabs";
import { AgentDetailSectionHeader } from "./agent-detail-split";

export type ConfigurationSection = "model" | "proxy" | "inputs" | "connections" | "schedules";

const CONFIGURATION_SECTION_TEXT: Record<
  ConfigurationSection,
  { labelKey: string; descriptionKey: string }
> = {
  model: {
    labelKey: "detail.configuration.model",
    descriptionKey: "detail.configuration.modelIntro",
  },
  proxy: {
    labelKey: "detail.configSectionProxy",
    descriptionKey: "detail.configuration.proxyIntro",
  },
  inputs: {
    labelKey: "detail.configuration.inputsShort",
    descriptionKey: "detail.configuration.inputsDescription",
  },
  connections: {
    labelKey: "detail.configuration.connections",
    descriptionKey: "detail.configuration.connectionsDescription",
  },
  schedules: {
    labelKey: "detail.configuration.schedulesShort",
    descriptionKey: "detail.configuration.schedulesDescription",
  },
};

export function AgentConfigurationView({
  packageId,
  detail,
  configSchemaOverride,
  isHistorical,
  section,
}: {
  packageId: string;
  detail: AgentDetail;
  configSchemaOverride?: JSONSchemaObject;
  isHistorical?: boolean;
  section: ConfigurationSection;
}) {
  const { t } = useTranslation("agents");
  const sharedConfigurationProps = {
    packageId,
    configSchemaOverride: isHistorical ? configSchemaOverride : detail.input?.schema,
    isHistorical,
    showSectionDescription: false,
  };

  const sectionBody = (() => {
    if (section === "model") {
      return <AgentConfigurationTab {...sharedConfigurationProps} section="model" />;
    }
    if (section === "proxy") {
      return <AgentConfigurationTab {...sharedConfigurationProps} section="proxy" />;
    }
    if (section === "inputs") {
      return <AgentConfigurationTab {...sharedConfigurationProps} section="inputs" />;
    }
    if (section === "connections") {
      return isHistorical ? (
        <p className="text-muted-foreground text-sm">
          {t("detail.configuration.historicalUnavailable")}
        </p>
      ) : (
        <div className="space-y-4">
          <AgentConnectionsSection packageId={packageId} detail={detail} />
        </div>
      );
    }
    return isHistorical ? (
      <p className="text-muted-foreground text-sm">
        {t("detail.configuration.historicalUnavailable")}
      </p>
    ) : (
      <div className="space-y-4">
        <AgentSchedulesTab packageId={packageId} />
      </div>
    );
  })();

  const text = CONFIGURATION_SECTION_TEXT[section];

  return (
    <section className="min-w-0 p-6">
      <AgentDetailSectionHeader title={t(text.labelKey)} description={t(text.descriptionKey)} />
      <div>{sectionBody}</div>
    </section>
  );
}
