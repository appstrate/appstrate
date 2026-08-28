// SPDX-License-Identifier: Apache-2.0

import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  BrainCircuit,
  CalendarClock,
  FolderTree,
  Globe,
  Plug,
  SlidersHorizontal,
  Workflow,
} from "lucide-react";
import type { AgentDetail } from "@appstrate/shared-types";
import type { JSONSchemaObject } from "@appstrate/core/form";
import { RailLink } from "../settings/rail-link";
import { AgentOverviewTab } from "./agent-overview-tab";
import { AgentConfigurationView, type ConfigurationSection } from "./agent-configuration-view";
import { AgentDetailSplit } from "./agent-detail-split";

type AgentSettingsSection = ConfigurationSection | "map" | "files";

const SETTINGS_GROUPS = [
  {
    labelKey: "detail.settings.configurationGroup",
    items: [
      { id: "model", icon: BrainCircuit, labelKey: "detail.configuration.model" },
      { id: "proxy", icon: Globe, labelKey: "detail.configSectionProxy" },
      { id: "inputs", icon: SlidersHorizontal, labelKey: "detail.configuration.inputsShort" },
      { id: "connections", icon: Plug, labelKey: "detail.configuration.connections" },
      { id: "schedules", icon: CalendarClock, labelKey: "detail.configuration.schedulesShort" },
    ],
  },
  {
    labelKey: "detail.settings.structureGroup",
    items: [
      { id: "map", icon: Workflow, labelKey: "detail.overview.map" },
      { id: "files", icon: FolderTree, labelKey: "detail.overview.explorer" },
    ],
  },
] satisfies Array<{
  labelKey: string;
  items: Array<{ id: AgentSettingsSection; icon: typeof BrainCircuit; labelKey: string }>;
}>;

const SETTINGS_SECTION_IDS: readonly AgentSettingsSection[] = [
  "model",
  "proxy",
  "inputs",
  "connections",
  "schedules",
  "map",
  "files",
];

export function AgentSettingsView({
  packageId,
  detail,
  version,
  isHistorical,
  configSchemaOverride,
  currentManifest,
  currentContent,
}: {
  packageId: string;
  detail: AgentDetail;
  version?: string;
  isHistorical: boolean;
  configSchemaOverride?: JSONSchemaObject;
  currentManifest?: Record<string, unknown>;
  currentContent?: string | null;
}) {
  const { t } = useTranslation("agents");
  const location = useLocation();
  const navigate = useNavigate();
  const requested = new URLSearchParams(location.search).get("agentSettings");
  const activeSection = SETTINGS_SECTION_IDS.includes(requested as AgentSettingsSection)
    ? (requested as AgentSettingsSection)
    : "model";

  const sectionHref = (section: AgentSettingsSection) => {
    const search = new URLSearchParams(location.search);
    if (section === "model") search.delete("agentSettings");
    else search.set("agentSettings", section);
    search.delete("agentConfig");
    const query = search.toString();
    return `${location.pathname}${query ? `?${query}` : ""}#settings`;
  };

  const openFiles = () => {
    void navigate(sectionHref("files"));
  };

  const body =
    activeSection === "map" || activeSection === "files" ? (
      <AgentOverviewTab
        packageId={packageId}
        detail={detail}
        version={version}
        isHistorical={isHistorical}
        currentManifest={currentManifest}
        currentContent={currentContent}
        surface={activeSection}
        onOpenFiles={openFiles}
      />
    ) : (
      <AgentConfigurationView
        packageId={packageId}
        detail={detail}
        configSchemaOverride={configSchemaOverride}
        isHistorical={isHistorical}
        section={activeSection}
        embedded
      />
    );

  return (
    <AgentDetailSplit
      data-agent-settings
      railClassName="p-6"
      rail={
        <nav className="space-y-5" aria-label={t("detail.tabSettings")}>
          {SETTINGS_GROUPS.map((group) => (
            <section key={group.labelKey}>
              <h2 className="text-muted-foreground mb-1 px-2 text-[11px] font-semibold tracking-wide uppercase">
                {t(group.labelKey)}
              </h2>
              <div className="flex flex-col gap-0.5">
                {group.items.map((item) => (
                  <RailLink
                    key={item.id}
                    item={{ to: sectionHref(item.id), icon: item.icon, labelKey: item.labelKey }}
                    label={t(item.labelKey)}
                    active={activeSection === item.id}
                  />
                ))}
              </div>
            </section>
          ))}
        </nav>
      }
    >
      {body}
    </AgentDetailSplit>
  );
}
