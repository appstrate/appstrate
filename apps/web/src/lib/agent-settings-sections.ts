// SPDX-License-Identifier: Apache-2.0

/**
 * An agent's settings sections: the rail's order, which are a space's, which one opens. Read by
 * the settings view and by its skeleton (`loading-skeletons.tsx`), which must not load the view
 * to draw it.
 */

import { AGENT_DEFINITION_SECTIONS, type AgentSettingsSection } from "./settings-section-href";

/** The rail's groups and their sections, in order; the view adds the icons. */
export const AGENT_SETTINGS_GROUPS = [
  {
    labelKey: "detail.settings.exploreGroup",
    items: [
      { id: "files", labelKey: "detail.overview.explorer" },
      { id: "versions", labelKey: "detail.settings.versions" },
    ],
  },
  {
    labelKey: "detail.settings.configurationGroup",
    items: [
      { id: "model", labelKey: "detail.configuration.model" },
      { id: "proxy", labelKey: "detail.configSectionProxy" },
      { id: "inputs", labelKey: "detail.configuration.inputsShort" },
      { id: "connections", labelKey: "detail.configuration.connections" },
      { id: "schedules", labelKey: "detail.configuration.schedulesShort" },
    ],
  },
  {
    labelKey: "detail.settings.definitionGroup",
    items: [
      { id: "general", labelKey: "editor.tabGeneral" },
      { id: "schema", labelKey: "editor.tabSchema" },
      { id: "skills", labelKey: "common:nav.skills" },
      { id: "integrations", labelKey: "common:nav.integrations" },
    ],
  },
] as const satisfies ReadonlyArray<{
  labelKey: string;
  items: ReadonlyArray<{ id: AgentSettingsSection; labelKey: string }>;
}>;

const SECTION_IDS: readonly AgentSettingsSection[] = AGENT_SETTINGS_GROUPS.flatMap((group) =>
  group.items.map((item) => item.id),
);

/** A system agent has no history of its own to browse. */
export const agentSettingsApplies = (section: string, isSystem: boolean) =>
  section !== "versions" || !isSystem;

/** What decides which sections a reader opens. */
export interface AgentSectionGrants {
  /** Whether some space the section is read from grants `permission`. */
  grants: (permission: string) => boolean;
  readsSchedules: boolean;
  /** The definition is edited where it is read, by whoever may write it. */
  canEditDefinition: boolean;
  isSystem: boolean;
}

/** Whether the reader opens `section`; a section they do not is locked in the rail. */
export function agentSectionVisible(section: AgentSettingsSection, g: AgentSectionGrants): boolean {
  const permission = SECTION_PERMISSION[section];
  if (section === "versions" && g.isSystem) return false;
  if (permission) return g.grants(permission);
  if (section === "schedules") return g.readsSchedules;
  if ((AGENT_DEFINITION_SECTIONS as readonly string[]).includes(section))
    return g.canEditDefinition;
  return true;
}

/** The sections that apply to the agent, in the rail's order. */
const agentSettingsSections = (isSystem: boolean): AgentSettingsSection[] =>
  SECTION_IDS.filter((id) => agentSettingsApplies(id, isSystem));

/**
 * The section the rail opens: the one asked for by name (even locked: its panel explains), else
 * the model when the reader opens it, else the first they open.
 */
export function resolveAgentSettingsSection(
  requested: string | null,
  g: AgentSectionGrants,
): AgentSettingsSection {
  const applicable = agentSettingsSections(g.isSystem);
  if (requested && (applicable as readonly string[]).includes(requested)) {
    return requested as AgentSettingsSection;
  }
  if (agentSectionVisible("model", g)) return "model";
  return (
    applicable.find((section) => agentSectionVisible(section, g)) ?? applicable[0] ?? "connections"
  );
}

/** The Connexions section's: its integration reads are not implied by the agent's route. */
const CONNECTIONS_PERMISSION = "integrations:read";

/** The permission a section asks of the space it is read or set from. */
export const SECTION_PERMISSION: Partial<Record<AgentSettingsSection, string>> = {
  model: "agents:configure",
  proxy: "agents:configure",
  inputs: "agents:configure",
  connections: CONNECTIONS_PERMISSION,
  files: "agents:read",
  versions: "agents:read",
};

const SPACE_SETTINGS: ReadonlySet<string> = new Set<AgentSettingsSection>([
  "model",
  "proxy",
  "inputs",
  "connections",
]);

/** The sections set in one space (`space_packages`). */
export const isSpaceSetting = (section: string) => SPACE_SETTINGS.has(section);

/** Whether the agent page's Connexions section shows for the working space's grants. */
export function agentConnectionsTabVisible(can: (permission: string) => boolean): boolean {
  return can(CONNECTIONS_PERMISSION);
}
