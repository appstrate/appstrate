// SPDX-License-Identifier: Apache-2.0

/**
 * Which of an agent's settings sections are a space's, read by the settings view and by its
 * skeleton (`loading-skeletons.tsx`), which must not load the view to draw it.
 */

import type { AgentSettingsSection } from "./settings-section-href";

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
