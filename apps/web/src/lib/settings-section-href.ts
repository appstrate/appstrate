// SPDX-License-Identifier: Apache-2.0

/**
 * Addresses of a package's Paramètres sections: the section named in the query
 * (the default one included), the tab in the hash. A link to a section carries
 * nothing else from the page it leaves, so a modal open there does not follow.
 */
export type ConfigurationSection = "model" | "proxy" | "inputs" | "connections" | "schedules";

/** One editor, its sections switched without leaving it. */
export const AGENT_DEFINITION_SECTIONS = [
  "general",
  "schema",
  "skills",
  "integrations",
  "tools",
] as const;

export type AgentDefinitionSection = (typeof AGENT_DEFINITION_SECTIONS)[number];

/**
 * Package AFPS › Contenu is `bundle` in the URL: `files` is Explorer's tree.
 * `map` is the agent map, present only with the `agent-map` module.
 */
export type AgentSettingsSection =
  ConfigurationSection | AgentDefinitionSection | "bundle" | "files" | "versions" | "map";

export type PackageSettingsSection = "files" | "versions" | "general" | "bundle";

export type IntegrationSettingsSection =
  | "map"
  | "files"
  | "versions"
  | "functioning"
  | "authentication"
  | "access"
  | "identity"
  | "source"
  | "auth-methods"
  | "tools"
  | "bundle";

/** `extra` names what opens inside the section: a file, a modal. */
type Extra = Record<string, string>;

function sectionHref(
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

export function packageSettingsHref(
  pathname: string,
  section: PackageSettingsSection,
  extra?: Extra,
) {
  return sectionHref(pathname, "settings", "packageSettings", section, extra);
}

/** An integration's Paramètres is its `configuration` tab. */
export function integrationSettingsHref(
  pathname: string,
  section: IntegrationSettingsSection,
  extra?: Extra,
) {
  return sectionHref(pathname, "configuration", "integrationSettings", section, extra);
}

/**
 * The editor a Paramètres URL mounts, for `EditorPlaceContext`: its section as
 * the view resolves it (the package's definition sections are one editor) and
 * the file its view is keyed on, which remounts it as surely as a section does.
 */
export function settingsEditorPlace(
  section: string,
  search: URLSearchParams,
  definitionSections: readonly string[] = AGENT_DEFINITION_SECTIONS,
): string {
  const editor = definitionSections.includes(section) ? "definition" : section;
  return `${editor}|${search.get("file") ?? ""}`;
}
