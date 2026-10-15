// SPDX-License-Identifier: Apache-2.0

// Paramètres section URLs: the section in the query, the tab in the hash. A link carries
// nothing else from the page it leaves, so a modal open there does not follow.
export type ConfigurationSection = "model" | "proxy" | "inputs" | "connections" | "schedules";

export const AGENT_DEFINITION_SECTIONS = [
  "general",
  "schema",
  "skills",
  "integrations",
  "tools",
] as const;

export type AgentDefinitionSection = (typeof AGENT_DEFINITION_SECTIONS)[number];

export type AgentSettingsSection =
  ConfigurationSection | AgentDefinitionSection | PackageCommonSectionId;

/** The sections every package's Paramètres has (`PackageCommonSection`). */
export type PackageCommonSectionId = "files" | "versions";

export const isPackageCommonSection = (section: string): section is PackageCommonSectionId =>
  section === "files" || section === "versions";

export type PackageSettingsSection = PackageCommonSectionId | "general";

export type IntegrationSettingsSection =
  | "files"
  | "versions"
  | "functioning"
  | "authentication"
  | "access"
  | "identity"
  | "source"
  | "auth-methods"
  | "tools";

/** `extra` names what opens inside the section: a file, a modal. */
type Extra = Record<string, string>;

export function sectionHref(
  pathname: string,
  tab: string,
  param: string,
  section: string,
  extra: Extra = {},
) {
  return `${pathname}?${new URLSearchParams({ [param]: section, ...extra }).toString()}#${tab}`;
}

export function agentSettingsHref(pathname: string, section: AgentSettingsSection, extra?: Extra) {
  return sectionHref(pathname, "settings", "agentSettings", section, extra);
}

/** An integration's Paramètres is its `configuration` tab. */
export function integrationSettingsHref(
  pathname: string,
  section: IntegrationSettingsSection,
  extra?: Extra,
) {
  return sectionHref(pathname, "configuration", "integrationSettings", section, extra);
}

/** The editor a Paramètres URL mounts, for `EditorPlaceContext`: the definition sections are one editor, and the `file` remounts it like a section. */
export function settingsEditorPlace(
  section: string,
  search: URLSearchParams,
  definitionSections: readonly string[] = AGENT_DEFINITION_SECTIONS,
): string {
  const editor = definitionSections.includes(section) ? "definition" : section;
  return `${editor}|${search.get("file") ?? ""}`;
}
