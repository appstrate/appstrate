// SPDX-License-Identifier: Apache-2.0

/**
 * Which section an integration's Paramètres opens, read by the page and by its skeleton
 * (`loading-skeletons.tsx`), which must not load the page to draw it.
 */

import type { IntegrationSettingsSection } from "./settings-section-href";

/** The definition's sections, edited where they are read. */
export const INTEGRATION_DEFINITION_SECTIONS: readonly IntegrationSettingsSection[] = [
  "identity",
  "source",
  "auth-methods",
  "tools",
];

/** What decides the section an integration's rail opens. */
export interface IntegrationSectionGrants {
  /** Whether some space the integration is active in lets the reader configure it. */
  canConfigure: boolean;
  /** An organization's own package keeps its version history. */
  isOwned: boolean;
  /** Whether the reader edits the definition here. */
  hasDefinition: boolean;
}

/**
 * The section the rail opens: the one asked for by name where it exists, else the files when the
 * reader does not configure it, else the Authentification (or the space section asked for).
 */
export function resolveIntegrationSettingsSection(
  requested: string | null,
  { canConfigure, isOwned, hasDefinition }: IntegrationSectionGrants,
): IntegrationSettingsSection {
  if (
    requested === "tools" ||
    requested === "functioning" ||
    (requested === "versions" && isOwned) ||
    (hasDefinition &&
      requested &&
      (INTEGRATION_DEFINITION_SECTIONS as readonly string[]).includes(requested))
  ) {
    return requested as IntegrationSettingsSection;
  }
  if (requested === "files" || !canConfigure) return "files";
  return requested === "access" ? requested : "authentication";
}

const INTEGRATION_SPACE_SECTIONS = ["authentication", "access"] as const;
type IntegrationSpaceSection = (typeof INTEGRATION_SPACE_SECTIONS)[number];

/** Whether `section` is set in one space, read from the one the space line names. */
export const isIntegrationSpaceSection = (
  section: IntegrationSettingsSection,
): section is IntegrationSpaceSection =>
  (INTEGRATION_SPACE_SECTIONS as readonly string[]).includes(section);
