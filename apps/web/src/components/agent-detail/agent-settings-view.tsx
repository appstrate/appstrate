// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense, useCallback, type ComponentProps } from "react";
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
  Wrench,
} from "lucide-react";
import type { AgentDetail } from "@appstrate/shared-types";
import type { SchemaWrapper } from "@appstrate/core/form";
import type { Versioned } from "../../hooks/use-packages";
import { EditorPlaceContext } from "../../hooks/use-unsaved-changes";
import { RoleLimitNotice } from "../role-limit-notice";
import { usePermissions } from "../../hooks/use-permissions";
import { agentConnectionsTabVisible } from "../../lib/route-access";
import {
  AGENT_DEFINITION_SECTIONS,
  agentSettingsHref,
  settingsEditorPlace,
  type AgentSettingsSection,
  type ConfigurationSection,
} from "../../lib/settings-section-href";
import type { EditorPlace } from "../../lib/editor-place";
import { SectionRail } from "../settings/section-rail";
import { AgentOverviewTab } from "./agent-overview-tab";
import { AgentConfigurationView } from "./agent-configuration-view";
import { AgentDetailSplit } from "./agent-detail-split";
import { LoadingState } from "../page-states";
import { PackageVersionsSection } from "../package-detail/package-versions-section";
import { PackageFilesSection } from "../package-files/package-files-section";
import type { AgentDefinitionSection } from "../../pages/package-editor";

/** The editor sections, lazily: the editor weighs more than the page reading it. */
const AgentDefinitionEditor = lazy(() =>
  import("../../pages/package-editor").then((module) => ({
    default: module.AgentDefinitionEditor,
  })),
);

/**
 * Explorer: the package's raw files and its versions. Then what is set HERE
 * (Configuration), then what the package IS for every space (Définition),
 * where it is changed.
 */
const SETTINGS_GROUPS = [
  {
    labelKey: "detail.settings.exploreGroup",
    items: [
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

const SETTINGS_SECTION_IDS: readonly string[] = SETTINGS_GROUPS.flatMap((group) =>
  group.items.map((item) => item.id),
);

const isDefinitionSection = (section: string) =>
  (AGENT_DEFINITION_SECTIONS as readonly string[]).includes(section);

/** A system agent has no history of its own to browse. */
const applies = (section: string, isSystem: boolean) => section !== "versions" || !isSystem;

export function AgentSettingsView({
  packageId,
  detail,
  version,
  isHistorical,
  inputWrapperOverride,
  currentManifest,
  currentContent,
  versions,
}: {
  versions: Omit<ComponentProps<typeof PackageVersionsSection>, "type" | "packageId">;
  packageId: string;
  detail: Versioned<AgentDetail>;
  version?: string;
  isHistorical: boolean;
  inputWrapperOverride?: SchemaWrapper;
  currentManifest?: Record<string, unknown>;
  currentContent?: string | null;
}) {
  const { t } = useTranslation("agents");
  const location = useLocation();
  const navigate = useNavigate();
  const { can } = usePermissions();
  // Write authority is the package's HOME space (`home_writable`), never the
  // space being browsed; nobody writes a system agent or a pinned version.
  const canEditDefinition = !!detail.home_writable && !isHistorical;
  // Three permissions behind one rail: configuring the agent, reading its
  // schedules, reading what it is made of. Connections are open to anyone who
  // reaches the agent.
  // Every section stays in the rail for every role; one the role does not open
  // is marked with a lock and its panel says why (`RoleLimitNotice`). Only a
  // section that does not apply to this agent at all leaves the rail.
  const isSystem = detail.source === "system";
  const visible = (section: AgentSettingsSection) => {
    if (section === "model" || section === "proxy" || section === "inputs") {
      return can("agents:configure");
    }
    if (section === "schedules") return can("schedules:read");
    if (section === "connections") return agentConnectionsTabVisible(can);
    if (section === "files" || section === "bundle") {
      return can("agents:read");
    }
    // A system agent has no history of its own to browse.
    if (section === "versions") return can("agents:read") && detail.source !== "system";
    // The definition is edited where it is read, by whoever may write it, on
    // an org-owned draft. Everyone else keeps Fichiers to read it.
    if (isDefinitionSection(section)) return canEditDefinition;
    return true;
  };
  const groups = SETTINGS_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => applies(item.id, isSystem)),
  })).filter((group) => group.items.length > 0);
  const applicable = SETTINGS_SECTION_IDS.filter((id) =>
    applies(id, isSystem),
  ) as AgentSettingsSection[];
  const firstOpen = applicable.find(visible) ?? applicable[0] ?? "connections";
  const defaultSection: AgentSettingsSection = visible("model") ? "model" : firstOpen;
  // A section asked for by name opens even when locked: its panel explains.
  const sectionOf = useCallback(
    (search: URLSearchParams): AgentSettingsSection => {
      const requested = search.get("agentSettings") ?? "";
      return SETTINGS_SECTION_IDS.includes(requested) && applies(requested, isSystem)
        ? (requested as AgentSettingsSection)
        : defaultSection;
    },
    [isSystem, defaultSection],
  );
  const params = new URLSearchParams(location.search);
  const activeSection = sectionOf(params);
  const requestedFile = params.get("file") ?? undefined;
  const editorPlace = useCallback<EditorPlace>(
    (search) => settingsEditorPlace(sectionOf(search), search),
    [sectionOf],
  );

  const sectionHref = (section: AgentSettingsSection) =>
    agentSettingsHref(location.pathname, section);
  // The manifest is edited through its forms, its raw editor over Identité.
  const fileEditHref = (path: string) =>
    path === "manifest.json"
      ? agentSettingsHref(location.pathname, "general", { editManifest: "1" })
      : undefined;
  const filesHref = (path: string) => agentSettingsHref(location.pathname, "files", { file: path });

  const body = !visible(activeSection) ? (
    <div className="p-6">
      <RoleLimitNotice>
        {t(
          isDefinitionSection(activeSection)
            ? "detail.roleLimit.editDefinition"
            : "detail.roleLimit.section",
        )}
      </RoleLimitNotice>
    </div>
  ) : activeSection === "versions" ? (
    <PackageVersionsSection type="agent" packageId={packageId} {...versions} />
  ) : activeSection === "bundle" ? (
    <PackageFilesSection
      type="agent"
      packageId={packageId}
      manifest={detail.manifest ?? {}}
      filesHref={filesHref}
    />
  ) : isDefinitionSection(activeSection) ? (
    <Suspense fallback={<LoadingState />}>
      <AgentDefinitionEditor
        detail={detail}
        section={activeSection as AgentDefinitionSection}
        onSection={(next) => void navigate(sectionHref(next))}
      />
    </Suspense>
  ) : activeSection === "files" ? (
    <AgentOverviewTab
      packageId={packageId}
      detail={detail}
      version={version}
      isHistorical={isHistorical}
      currentManifest={currentManifest}
      currentContent={currentContent}
      key={requestedFile}
      surface="files"
      initialFilePath={requestedFile}
      fileEditHref={canEditDefinition ? fileEditHref : undefined}
      canEditFiles={canEditDefinition}
    />
  ) : (
    <AgentConfigurationView
      packageId={packageId}
      detail={detail}
      inputWrapperOverride={inputWrapperOverride}
      isHistorical={isHistorical}
      // Past the branches above, only configuration sections remain.
      section={activeSection as ConfigurationSection}
    />
  );

  return (
    <EditorPlaceContext.Provider value={editorPlace}>
      <AgentDetailSplit
        data-agent-settings
        rail={
          <SectionRail
            label={t("detail.tabSettings")}
            active={activeSection}
            groups={groups.map((group) => ({
              title: t(group.labelKey),
              items: group.items.map((item) => ({
                id: item.id,
                to: sectionHref(item.id),
                icon: item.icon,
                label: t(item.labelKey),
                locked: !visible(item.id),
              })),
            }))}
          />
        }
      >
        {body}
      </AgentDetailSplit>
    </EditorPlaceContext.Provider>
  );
}
