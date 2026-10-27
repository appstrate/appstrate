// SPDX-License-Identifier: Apache-2.0

/**
 * What the settings rail holds for THIS caller. The rail and the index
 * redirect both read it, so the overlay never opens on a page its own menu
 * does not list.
 */
import { useCanReach } from "../../hooks/use-can-reach";
import { visibleSettingsSections, type UnifiedSettingsSection } from "./navigation";

export function useSettingsSections(): UnifiedSettingsSection[] {
  return visibleSettingsSections(useCanReach());
}
