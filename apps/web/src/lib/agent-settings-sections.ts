// SPDX-License-Identifier: Apache-2.0

/**
 * Which of an agent's settings sections are a space's, read by the settings view and by its
 * skeleton (`loading-skeletons.tsx`), which must not load the view to draw it.
 */

import type { AgentSettingsSection } from "./settings-section-href";

/** The permission a section asks of the space it is read or set from. */
export const SECTION_PERMISSION: Partial<Record<AgentSettingsSection, string>> = {
  model: "agents:configure",
  proxy: "agents:configure",
  inputs: "agents:configure",
  // Its integration reads are not implied by the route.
  connections: "integrations:read",
  files: "agents:read",
  versions: "agents:read",
};

/** The sections set in one space (`space_packages`). */
export const isSpaceSetting = (section: string) =>
  section === "model" || section === "proxy" || section === "inputs" || section === "connections";
