// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense } from "react";
import { useNavigate } from "react-router-dom";
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
import type { SchemaWrapper } from "@appstrate/core/form";
import type { Versioned } from "../../hooks/use-packages";
import { RoleLimitNotice } from "../role-limit-notice";
import { usePermissions } from "../../hooks/use-permissions";
import { useAppConfig } from "../../hooks/use-app-config";
import { agentConnectionsTabVisible } from "../../lib/route-access";
import {
  AGENT_DEFINITION_SECTIONS,
  type AgentDefinitionSection,
  isPackageCommonSection,
  type AgentSettingsSection,
  type ConfigurationSection,
} from "../../lib/settings-section-href";
import { SettingsRailView } from "../settings/settings-rail-view";
import { AgentConfigurationView } from "./agent-configuration-view";
import { SettingsSkeleton } from "../loading-skeletons";
import { AgentMapSurface } from "../../modules/agent-map/agent-map-surface";
import {
  PackageCommonSection,
  type PackageVersionsProps,
} from "../package-detail/package-common-section";

/** The editor sections, lazily: the editor weighs more than the page reading it. */
const AgentDefinitionEditor = lazy(() =>
  import("../../pages/package-editor").then((module) => ({
    default: module.AgentDefinitionEditor,
  })),
);

/**
 * Explorer: the map (where its definition and this space's setup meet), the
 * package's raw files and its versions. Then what is set HERE
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

const SETTINGS_SECTION_IDS: readonly string[] = SETTINGS_GROUPS.flatMap((group) =>
  group.items.map((item) => item.id),
);

const isDefinitionSection = (section: string) =>
  (AGENT_DEFINITION_SECTIONS as readonly string[]).includes(section);

/**
 * A system agent has no history of its own to browse. The map is served by the
 * opt-in `agent-map` module: without it the section has nothing to show.
 */
const applies = (section: string, isSystem: boolean, hasMap: boolean) =>
  (section !== "versions" || !isSystem) && (section !== "map" || hasMap);

export function AgentSettingsView({
  packageId,
  detail,
  version,
  isHistorical,
  inputWrapperOverride,
  versions,
}: {
  versions: PackageVersionsProps;
  packageId: string;
  detail: Versioned<AgentDetail>;
  version?: string;
  isHistorical: boolean;
  inputWrapperOverride?: SchemaWrapper;
}) {
  const { t } = useTranslation("agents");
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
  const hasMap = !!useAppConfig().features.agentMap;
  const visible = (section: AgentSettingsSection) => {
    if (section === "model" || section === "proxy" || section === "inputs") {
      return can("agents:configure");
    }
    if (section === "schedules") return can("schedules:read");
    if (section === "connections") return agentConnectionsTabVisible(can);
    if (section === "map" || section === "files" || section === "bundle") {
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
    title: t(group.labelKey),
    items: group.items
      .filter((item) => applies(item.id, isSystem, hasMap))
      .map((item) => ({
        id: item.id,
        icon: item.icon,
        label: t(item.labelKey),
        locked: !visible(item.id),
      })),
  })).filter((group) => group.items.length > 0);
  const applicable = SETTINGS_SECTION_IDS.filter((id) =>
    applies(id, isSystem, hasMap),
  ) as AgentSettingsSection[];
  const firstOpen = applicable.find(visible) ?? applicable[0] ?? "connections";
  const defaultSection: AgentSettingsSection = visible("model") ? "model" : firstOpen;
  // A section asked for by name opens even when locked: its panel explains.
  const resolve = (requested: string | null): AgentSettingsSection =>
    requested && SETTINGS_SECTION_IDS.includes(requested) && applies(requested, isSystem, hasMap)
      ? (requested as AgentSettingsSection)
      : defaultSection;

  return (
    <SettingsRailView
      param="agentSettings"
      tab="settings"
      label={t("detail.tabSettings")}
      groups={groups}
      resolve={resolve}
      definitionSections={AGENT_DEFINITION_SECTIONS}
    >
      {({ active, file, href }) =>
        !visible(active) ? (
          <div className="p-6">
            <RoleLimitNotice>
              {t(
                isDefinitionSection(active)
                  ? "detail.roleLimit.editDefinition"
                  : "detail.roleLimit.section",
              )}
            </RoleLimitNotice>
          </div>
        ) : active === "map" ? (
          <AgentMapSurface
            packageId={packageId}
            detail={detail}
            version={version}
            onOpenFiles={() => void navigate(href("files"))}
          />
        ) : isPackageCommonSection(active) ? (
          <PackageCommonSection
            section={active}
            type="agent"
            packageId={packageId}
            manifest={detail.manifest ?? {}}
            file={file}
            href={href}
            version={version}
            // The manifest is edited through its forms, its raw editor over Identité.
            manifestSection={canEditDefinition ? "general" : undefined}
            versions={versions}
          />
        ) : isDefinitionSection(active) ? (
          <Suspense fallback={<SettingsSkeleton />}>
            <AgentDefinitionEditor
              detail={detail}
              section={active as AgentDefinitionSection}
              onSection={(next) => void navigate(href(next))}
            />
          </Suspense>
        ) : (
          <AgentConfigurationView
            packageId={packageId}
            detail={detail}
            inputWrapperOverride={inputWrapperOverride}
            isHistorical={isHistorical}
            // Past the branches above, only configuration sections remain.
            section={active as ConfigurationSection}
          />
        )
      }
    </SettingsRailView>
  );
}
