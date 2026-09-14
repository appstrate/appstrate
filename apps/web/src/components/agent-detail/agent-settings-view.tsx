// SPDX-License-Identifier: Apache-2.0

import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  BrainCircuit,
  CalendarClock,
  FolderTree,
  Globe,
  Pencil,
  Plug,
  SlidersHorizontal,
  Workflow,
} from "lucide-react";
import type { AgentDetail } from "@appstrate/shared-types";
import type { JSONSchemaObject } from "@appstrate/core/form";
import { Button } from "@appstrate/ui/components/button";
import { usePermissions } from "../../hooks/use-permissions";
import { RailLink } from "../settings/rail-link";
import { AgentOverviewTab } from "./agent-overview-tab";
import { AgentConfigurationView, type ConfigurationSection } from "./agent-configuration-view";
import { AgentDetailSplit } from "./agent-detail-split";

type AgentSettingsSection = ConfigurationSection | "map" | "files";

/**
 * The map first, on its own: it is the one view where the package's
 * definition and this space's setup meet — and it edits both — so it belongs
 * to neither group. Then what is set HERE (Configuration), then what the
 * package IS, for every space (Définition).
 */
const SETTINGS_GROUPS = [
  {
    labelKey: null,
    items: [{ id: "map", icon: Workflow, labelKey: "detail.overview.map" }],
  },
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
    labelKey: "detail.settings.definitionGroup",
    items: [{ id: "files", icon: FolderTree, labelKey: "detail.overview.explorer" }],
  },
] satisfies Array<{
  labelKey: string | null;
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
  const { can } = usePermissions();
  // Three permissions behind one rail: configuring the agent, reading its
  // schedules, reading what it is made of. Connections are open to anyone who
  // reaches the agent.
  const visible = (section: AgentSettingsSection) => {
    if (section === "model" || section === "proxy" || section === "inputs") {
      return can("agents:configure");
    }
    if (section === "schedules") return can("schedules:read");
    if (section === "map" || section === "files") return can("agents:read");
    return true;
  };
  const groups = SETTINGS_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => visible(item.id)),
  })).filter((group) => group.items.length > 0);
  const requested = new URLSearchParams(location.search).get("agentSettings");
  const fallback: AgentSettingsSection = groups[0]?.items[0]?.id ?? "connections";
  const activeSection =
    SETTINGS_SECTION_IDS.includes(requested as AgentSettingsSection) &&
    visible(requested as AgentSettingsSection)
      ? (requested as AgentSettingsSection)
      : visible("model")
        ? "model"
        : fallback;

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

  // The definition is read here and changed in the bundle editor, for every
  // space at once: an explicit step, never a field edited in place.
  const canEditDefinition = can("agents:write") && detail.source !== "system" && !isHistorical;
  const editDefinitionHref = (() => {
    const search = new URLSearchParams(location.search);
    search.set("agentBundle", "prompt");
    return `${location.pathname}?${search.toString()}${location.hash}`;
  })();

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

  const content =
    activeSection === "files" && canEditDefinition ? (
      <>
        <DefinitionEditBar href={editDefinitionHref} />
        {body}
      </>
    ) : (
      body
    );

  return (
    <AgentDetailSplit
      data-agent-settings
      railClassName="p-6"
      rail={
        <nav className="space-y-5" aria-label={t("detail.tabSettings")}>
          {groups.map((group) => (
            <section key={group.labelKey ?? "overview"}>
              {group.labelKey && (
                <h2 className="text-muted-foreground mb-1 px-2 text-[11px] font-semibold tracking-wide uppercase">
                  {t(group.labelKey)}
                </h2>
              )}
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
      {content}
    </AgentDetailSplit>
  );
}

/** "Modifier" over a definition section: says it applies to every space. */
export function DefinitionEditBar({ href, onClick }: { href?: string; onClick?: () => void }) {
  const { t } = useTranslation("agents");
  const label = (
    <>
      <Pencil />
      {t("detail.settings.editDefinition")}
    </>
  );
  return (
    <div className="flex items-center justify-end gap-3 px-6 pt-6">
      <span className="text-muted-foreground text-xs">
        {t("detail.settings.editDefinitionScope")}
      </span>
      {href ? (
        <Button asChild variant="outline" size="sm">
          <Link to={href}>{label}</Link>
        </Button>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={onClick}>
          {label}
        </Button>
      )}
    </div>
  );
}
