// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense, type ComponentProps } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Boxes,
  Braces,
  BrainCircuit,
  CalendarClock,
  FileArchive,
  FolderTree,
  Globe,
  History,
  IdCard,
  Plug,
  SlidersHorizontal,
  Sparkles,
  Workflow,
  Wrench,
} from "lucide-react";
import type { AgentDetail } from "@appstrate/shared-types";
import type { JSONSchemaObject } from "@appstrate/core/form";
import { usePermissions } from "../../hooks/use-permissions";
import { RailLink } from "../settings/rail-link";
import { AgentOverviewTab } from "./agent-overview-tab";
import { AgentConfigurationView, type ConfigurationSection } from "./agent-configuration-view";
import { AgentDetailSplit } from "./agent-detail-split";
import { LoadingState } from "../page-states";
import { PackageVersionsSection } from "../package-detail/package-versions-section";
import { PackageFilesSection } from "../package-files/package-files-section";
import type { AgentDefinitionSection } from "../../pages/package-editor";

/**
 * Package AFPS › Contenu is `bundle` in the URL: `files` is Explorer's tree. It
 * is not an editor section — it reads the bundle, and its rows open Explorer.
 */
type AgentSettingsSection =
  ConfigurationSection | AgentDefinitionSection | "bundle" | "map" | "files" | "versions";

/** The editor sections, lazily: the editor weighs more than the page reading it. */
const AgentDefinitionEditor = lazy(() =>
  import("../../pages/package-editor").then((module) => ({
    default: module.AgentDefinitionEditor,
  })),
);

const DEFINITION_SECTION_IDS: readonly AgentDefinitionSection[] = [
  "general",
  "schema",
  "skills",
  "integrations",
  "tools",
];

/**
 * Explorer: two ways to SEE the package — the map (where its definition and
 * this space's setup meet) and its raw files. Then what is set HERE
 * (Configuration), then what the package IS for every space (Définition),
 * where it is changed.
 */
const SETTINGS_GROUPS = [
  {
    labelKey: "detail.settings.exploreGroup",
    items: [
      { id: "map", icon: Workflow, labelKey: "detail.overview.map" },
      { id: "files", icon: FolderTree, labelKey: "detail.overview.explorer" },
      { id: "versions", icon: History, labelKey: "detail.settings.versions" },
    ],
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
    items: [
      { id: "general", icon: IdCard, labelKey: "editor.tabGeneral" },
      { id: "schema", icon: Braces, labelKey: "editor.tabSchema" },
      { id: "skills", icon: Sparkles, labelKey: "editor.tabSkills" },
      { id: "integrations", icon: Boxes, labelKey: "editor.tabIntegrations" },
      { id: "tools", icon: Wrench, labelKey: "editor.tabTools" },
      { id: "bundle", icon: FileArchive, labelKey: "editor.tabPackageFiles" },
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
  ...DEFINITION_SECTION_IDS,
  "bundle",
  "files",
  "versions",
];

export function AgentSettingsView({
  packageId,
  detail,
  version,
  isHistorical,
  configSchemaOverride,
  currentManifest,
  currentContent,
  versions,
}: {
  versions: Omit<ComponentProps<typeof PackageVersionsSection>, "type" | "packageId">;
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
  const canEditDefinition = can("agents:write") && detail.source !== "system" && !isHistorical;
  // Three permissions behind one rail: configuring the agent, reading its
  // schedules, reading what it is made of. Connections are open to anyone who
  // reaches the agent.
  const visible = (section: AgentSettingsSection) => {
    if (section === "model" || section === "proxy" || section === "inputs") {
      return can("agents:configure");
    }
    if (section === "schedules") return can("schedules:read");
    if (section === "map" || section === "files" || section === "bundle") {
      return can("agents:read");
    }
    // A system agent has no history of its own to browse.
    if (section === "versions") return can("agents:read") && detail.source !== "system";
    // The definition is edited where it is read, by whoever may write it, on
    // an org-owned draft. Everyone else keeps Fichiers to read it.
    if ((DEFINITION_SECTION_IDS as readonly string[]).includes(section)) return canEditDefinition;
    return true;
  };
  const groups = SETTINGS_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => visible(item.id)),
  })).filter((group) => group.items.length > 0);
  const params = new URLSearchParams(location.search);
  const requestedRaw = params.get("agentSettings");
  // The prompt stopped being a section: it is a file, read in Contenu and
  // changed in Explorer › Fichiers.
  const requested = requestedRaw === "prompt" ? "files" : requestedRaw;
  const requestedFile = params.get("file") ?? undefined;
  const fallback: AgentSettingsSection = groups[0]?.items[0]?.id ?? "connections";
  const activeSection =
    SETTINGS_SECTION_IDS.includes(requested as AgentSettingsSection) &&
    visible(requested as AgentSettingsSection)
      ? (requested as AgentSettingsSection)
      : visible("model")
        ? "model"
        : fallback;

  const sectionHref = (section: AgentSettingsSection, file?: string) => {
    const search = new URLSearchParams(location.search);
    if (section === "model") search.delete("agentSettings");
    else search.set("agentSettings", section);
    search.delete("agentConfig");
    // A file modal belongs to the section it was opened in.
    search.delete("edit");
    search.delete("editManifest");
    search.delete("add");
    search.delete("tools");
    search.delete("field-input");
    search.delete("field-output");
    search.delete("file");
    if (file) search.set("file", file);
    const query = search.toString();
    return `${location.pathname}${query ? `?${query}` : ""}#settings`;
  };

  // The manifest is edited through its forms, its raw editor over Identité.
  const fileEditHref = (path: string) => {
    if (path !== "manifest.json") return undefined;
    const search = new URLSearchParams(location.search);
    search.set("agentSettings", "general");
    search.delete("file");
    search.set("editManifest", "1");
    return `${location.pathname}?${search.toString()}#settings`;
  };

  const filesHref = (path: string) => sectionHref("files", path);

  const openFiles = () => {
    void navigate(sectionHref("files"));
  };

  const body =
    activeSection === "versions" ? (
      <PackageVersionsSection type="agent" packageId={packageId} {...versions} />
    ) : activeSection === "bundle" ? (
      <PackageFilesSection
        type="agent"
        packageId={packageId}
        manifest={detail.manifest ?? {}}
        filesHref={filesHref}
      />
    ) : (DEFINITION_SECTION_IDS as readonly string[]).includes(activeSection) ? (
      <Suspense fallback={<LoadingState />}>
        <AgentDefinitionEditor
          detail={detail}
          section={activeSection as AgentDefinitionSection}
          onSection={(next) => void navigate(sectionHref(next))}
        />
      </Suspense>
    ) : activeSection === "map" || activeSection === "files" ? (
      <AgentOverviewTab
        packageId={packageId}
        detail={detail}
        version={version}
        isHistorical={isHistorical}
        currentManifest={currentManifest}
        currentContent={currentContent}
        key={activeSection === "files" ? requestedFile : undefined}
        surface={activeSection}
        initialFilePath={requestedFile}
        onOpenFiles={openFiles}
        fileEditHref={canEditDefinition ? fileEditHref : undefined}
        canEditFiles={canEditDefinition}
      />
    ) : (
      <AgentConfigurationView
        packageId={packageId}
        detail={detail}
        configSchemaOverride={configSchemaOverride}
        isHistorical={isHistorical}
        // Past the two branches above, only configuration sections remain.
        section={activeSection as ConfigurationSection}
        embedded
      />
    );

  return (
    <AgentDetailSplit
      data-agent-settings
      railClassName="p-6"
      rail={
        <nav className="space-y-5" aria-label={t("detail.tabSettings")}>
          {groups.map((group) => (
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
