// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { BrainCircuit, CalendarClock, Globe, Plug, SlidersHorizontal } from "lucide-react";
import type { AgentDetail } from "@appstrate/shared-types";
import type { JSONSchemaObject } from "@appstrate/core/form";
import { RailLink } from "../settings/rail-link";
import { AgentConfigurationTab } from "../package-detail/agent-configuration-tab";
import { AgentConnectionsSection } from "../package-detail/agent-connections-section";
import { AgentSchedulesTab } from "../package-detail/agent-tabs";
import { AgentDetailSplit } from "./agent-detail-split";

type ConfigurationSection = "model" | "proxy" | "inputs" | "connections" | "schedules";

const CONFIGURATION_SECTIONS: Array<{
  id: ConfigurationSection;
  icon: typeof BrainCircuit;
  labelKey: string;
}> = [
  { id: "model", icon: BrainCircuit, labelKey: "detail.configuration.model" },
  { id: "proxy", icon: Globe, labelKey: "detail.configSectionProxy" },
  { id: "inputs", icon: SlidersHorizontal, labelKey: "detail.configuration.inputsShort" },
  { id: "connections", icon: Plug, labelKey: "detail.configuration.connections" },
  { id: "schedules", icon: CalendarClock, labelKey: "detail.configuration.schedulesShort" },
];

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
  const location = useLocation();
  const requestedSection = new URLSearchParams(location.search).get("agentConfig");
  const activeSection = CONFIGURATION_SECTIONS.some((item) => item.id === requestedSection)
    ? (requestedSection as ConfigurationSection)
    : "model";
  const sharedConfigurationProps = {
    packageId,
    configSchemaOverride: isHistorical ? configSchemaOverride : detail.input?.schema,
    isHistorical,
  };

  const sectionHref = (section: ConfigurationSection) => {
    const search = new URLSearchParams(location.search);
    if (section === "model") search.delete("agentConfig");
    else search.set("agentConfig", section);
    const query = search.toString();
    return `${location.pathname}${query ? `?${query}` : ""}#configuration`;
  };

  const sectionBody = (() => {
    if (activeSection === "model") {
      return <AgentConfigurationTab {...sharedConfigurationProps} section="model" />;
    }
    if (activeSection === "proxy") {
      return <AgentConfigurationTab {...sharedConfigurationProps} section="proxy" />;
    }
    if (activeSection === "inputs") {
      return <AgentConfigurationTab {...sharedConfigurationProps} section="inputs" />;
    }
    if (activeSection === "connections") {
      return isHistorical ? (
        <p className="text-muted-foreground text-sm">
          {t("detail.configuration.historicalUnavailable")}
        </p>
      ) : (
        <div className="space-y-4">
          <p className="text-muted-foreground max-w-2xl text-sm">
            {t("detail.configuration.connectionsDescription")}
          </p>
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
        <p className="text-muted-foreground max-w-2xl text-sm">
          {t("detail.configuration.schedulesDescription")}
        </p>
        <AgentSchedulesTab packageId={packageId} />
      </div>
    );
  })();

  const activeLabel = t(CONFIGURATION_SECTIONS.find((item) => item.id === activeSection)!.labelKey);

  return (
    <AgentDetailSplit
      data-agent-configuration
      railClassName="p-3"
      rail={
        <nav
          className="flex flex-col gap-0.5 max-md:flex-row max-md:overflow-x-auto"
          aria-label={t("detail.tabConfiguration")}
        >
          {CONFIGURATION_SECTIONS.map((section) => (
            <RailLink
              key={section.id}
              item={{
                to: sectionHref(section.id),
                icon: section.icon,
                labelKey: section.labelKey,
              }}
              label={t(section.labelKey)}
              active={activeSection === section.id}
            />
          ))}
        </nav>
      }
    >
      <section className="min-w-0 p-6">
        <h2 className="text-lg font-semibold">{activeLabel}</h2>
        <div className="border-border mt-2 border-b" />
        <div className="pt-2">{sectionBody}</div>
      </section>
    </AgentDetailSplit>
  );
}
