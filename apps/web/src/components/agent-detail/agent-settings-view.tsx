// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import {
  Boxes,
  Braces,
  BrainCircuit,
  CalendarClock,
  FolderTree,
  Globe,
  History,
  IdCard,
  Plug,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import type { AgentDetail } from "@appstrate/shared-types";
import type { SchemaWrapper } from "@appstrate/core/form";
import type { Versioned } from "../../hooks/use-packages";
import { RoleLimitNotice } from "../role-limit-notice";
import { usePermissions } from "../../hooks/use-permissions";
import { useAdmittingSpaces, useOverviewMode } from "../../hooks/use-overview-mode";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { useSpacesFor } from "../../hooks/use-space-action";
import { useSpaceLabelOf } from "../../hooks/use-spaces";
import {
  AGENT_DEFINITION_SECTIONS,
  type AgentDefinitionSection,
  isPackageCommonSection,
  type AgentSettingsSection,
  type ConfigurationSection,
} from "../../lib/settings-section-href";
import {
  AGENT_SETTINGS_GROUPS,
  agentSectionVisible,
  agentSettingsApplies,
  isSpaceSetting,
  resolveAgentSettingsSection,
  SECTION_PERMISSION,
} from "../../lib/agent-settings-sections";
import { SettingsRailView } from "../settings/settings-rail-view";
import { AgentConfigurationSpace, AgentConfigurationView } from "./agent-configuration-view";
import { EditorPanelSkeleton } from "../loading-skeletons";
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
 * Explorer: the package's raw files and its versions. Then what is set HERE
 * (Configuration), then what the package IS for every space (Définition),
 * where it is changed. The groups are `AGENT_SETTINGS_GROUPS`; here, their icons.
 */
const SECTION_ICONS: Record<AgentSettingsSection, typeof BrainCircuit> = {
  files: FolderTree,
  versions: History,
  model: BrainCircuit,
  proxy: Globe,
  inputs: SlidersHorizontal,
  connections: Plug,
  schedules: CalendarClock,
  general: IdCard,
  schema: Braces,
  skills: Sparkles,
  integrations: Boxes,
};

const isDefinitionSection = (section: string) =>
  (AGENT_DEFINITION_SECTIONS as readonly string[]).includes(section);

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
  const { can } = usePermissions();
  const workingSpaceId = useCurrentSpaceId();
  const spaceLabelOf = useSpaceLabelOf();
  // In « Tous les espaces » a section opens where some space of the agent's grants it: a space
  // setting among its active spaces (the header's tiles), the others among its readable
  // placements; the schedules, which span spaces, where some space admits their list. With a
  // space selected, each is that space's verdict.
  const { on: overview } = useOverviewMode();
  const scheduleSpaces = useAdmittingSpaces("schedules");
  const readsSchedules = overview ? scheduleSpaces.length > 0 : can("schedules:read");
  const configures = useSpacesFor({ permission: "agents:configure" }, detail.space_ids).offered;
  const readsIntegrations = useSpacesFor(
    { permission: "integrations:read" },
    detail.space_ids,
  ).offered;
  const readsAgent = useSpacesFor({ permission: "agents:read" }, detail.read_space_ids).offered;
  const grants: Record<string, boolean | undefined> = {
    "agents:configure": configures,
    "integrations:read": readsIntegrations,
    "agents:read": readsAgent,
  };
  // Write authority is the package's HOME space (`home_writable`), never the
  // space being browsed; nobody writes a system agent or a pinned version.
  const canEditDefinition = !!detail.home_writable && !isHistorical;
  // Every section stays in the rail for every role; one the role does not open
  // is marked with a lock and its panel says why (`RoleLimitNotice`). Only a
  // section that does not apply to this agent at all leaves the rail.
  const isSystem = detail.source === "system";
  const sectionGrants = {
    grants: (permission: string) => !!grants[permission],
    readsSchedules,
    canEditDefinition,
    isSystem,
  };
  const visible = (section: AgentSettingsSection) => agentSectionVisible(section, sectionGrants);
  const groups = AGENT_SETTINGS_GROUPS.map((group) => ({
    title: t(group.labelKey),
    items: group.items
      .filter((item) => agentSettingsApplies(item.id, isSystem))
      .map((item) => ({
        id: item.id,
        icon: SECTION_ICONS[item.id],
        label: t(item.labelKey),
        locked: !visible(item.id),
      })),
  })).filter((group) => group.items.length > 0);
  const resolve = (requested: string | null): AgentSettingsSection =>
    resolveAgentSettingsSection(requested, sectionGrants);

  return (
    <SettingsRailView
      param="agentSettings"
      tab="settings"
      label={t("detail.tabSettings")}
      groups={groups}
      resolve={resolve}
      definitionSections={AGENT_DEFINITION_SECTIONS}
    >
      {({ active, file, href }) => {
        const permission = SECTION_PERMISSION[active];
        const placements = isSpaceSetting(active) ? detail.space_ids : detail.read_space_ids;
        const shownFrom = !!workingSpaceId && placements.includes(workingSpaceId);
        // In the mode, a section another space opens, from a space the header does not name or
        // whose role refuses it: the space to show it from comes first.
        const elsewhere =
          overview &&
          visible(active) &&
          !!permission &&
          ((isSpaceSetting(active) && !shownFrom) || !can(permission));
        if (elsewhere) {
          return (
            <div className="p-6">
              <AgentConfigurationSpace
                packageId={packageId}
                spaceIds={placements}
                permission={permission}
              />
              {/* The working space is named only where the page shows it. */}
              {shownFrom ? (
                <RoleLimitNotice>
                  {t("detail.roleLimit.sectionIn", {
                    space: spaceLabelOf(workingSpaceId) ?? "",
                  })}
                </RoleLimitNotice>
              ) : (
                <p className="text-muted-foreground text-sm">
                  {t("detail.configuration.pickSpaceHint")}
                </p>
              )}
            </div>
          );
        }
        return !visible(active) ? (
          <div className="p-6">
            <RoleLimitNotice>
              {t(
                isDefinitionSection(active)
                  ? "detail.roleLimit.editDefinition"
                  : "detail.roleLimit.section",
              )}
            </RoleLimitNotice>
          </div>
        ) : isPackageCommonSection(active) ? (
          <PackageCommonSection
            section={active}
            type="agent"
            packageId={packageId}
            file={file}
            href={href}
            version={version}
            // The manifest is edited through its forms, its raw editor over Identité.
            manifestSection={canEditDefinition ? "general" : undefined}
            versions={versions}
          />
        ) : isDefinitionSection(active) ? (
          <Suspense fallback={<EditorPanelSkeleton />}>
            <AgentDefinitionEditor detail={detail} section={active as AgentDefinitionSection} />
          </Suspense>
        ) : (
          <AgentConfigurationView
            packageId={packageId}
            detail={detail}
            inputWrapperOverride={inputWrapperOverride}
            isHistorical={isHistorical}
            // Past the branches above, only configuration sections remain.
            section={active as ConfigurationSection}
            permission={permission}
          />
        );
      }}
    </SettingsRailView>
  );
}
