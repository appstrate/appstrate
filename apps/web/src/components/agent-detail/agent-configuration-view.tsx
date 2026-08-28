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
import { AgentDetailSectionHeader, AgentDetailSplit } from "./agent-detail-split";

export type ConfigurationSection = "model" | "proxy" | "inputs" | "connections" | "schedules";

const CONFIGURATION_SECTIONS: Array<{
  id: ConfigurationSection;
  icon: typeof BrainCircuit;
  labelKey: string;
  descriptionKey: string;
}> = [
  {
    id: "model",
    icon: BrainCircuit,
    labelKey: "detail.configuration.model",
    descriptionKey: "detail.configuration.modelIntro",
  },
  {
    id: "proxy",
    icon: Globe,
    labelKey: "detail.configSectionProxy",
    descriptionKey: "detail.configuration.proxyIntro",
  },
  {
    id: "inputs",
    icon: SlidersHorizontal,
    labelKey: "detail.configuration.inputsShort",
    descriptionKey: "detail.configuration.inputsDescription",
  },
  {
    id: "connections",
    icon: Plug,
    labelKey: "detail.configuration.connections",
    descriptionKey: "detail.configuration.connectionsDescription",
  },
  {
    id: "schedules",
    icon: CalendarClock,
    labelKey: "detail.configuration.schedulesShort",
    descriptionKey: "detail.configuration.schedulesDescription",
  },
];

export function AgentConfigurationView({
  packageId,
  detail,
  configSchemaOverride,
  isHistorical,
  section,
  embedded = false,
}: {
  packageId: string;
  detail: AgentDetail;
  configSchemaOverride?: JSONSchemaObject;
  isHistorical?: boolean;
  section?: ConfigurationSection;
  embedded?: boolean;
}) {
  const { t } = useTranslation("agents");
  const location = useLocation();
  const requestedSection = new URLSearchParams(location.search).get("agentConfig");
  const activeSection =
    section ??
    (CONFIGURATION_SECTIONS.some((item) => item.id === requestedSection)
      ? (requestedSection as ConfigurationSection)
      : "model");
  const sharedConfigurationProps = {
    packageId,
    configSchemaOverride: isHistorical ? configSchemaOverride : detail.input?.schema,
    isHistorical,
    showSectionDescription: false,
  };

  const sectionHref = (section: ConfigurationSection) => {
    const search = new URLSearchParams(location.search);
    if (section === "model") search.delete("agentSettings");
    else search.set("agentSettings", section);
    search.delete("agentConfig");
    const query = search.toString();
    return `${location.pathname}${query ? `?${query}` : ""}#settings`;
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

  const activeItem = CONFIGURATION_SECTIONS.find((item) => item.id === activeSection)!;

  const content = (
    <section className="min-w-0 p-6">
      <AgentDetailSectionHeader
        title={t(activeItem.labelKey)}
        description={t(activeItem.descriptionKey)}
      />
      <div>{sectionBody}</div>
    </section>
  );

  if (embedded) return content;

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
      {content}
    </AgentDetailSplit>
  );
}
