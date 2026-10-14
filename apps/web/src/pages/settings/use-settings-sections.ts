// SPDX-License-Identifier: Apache-2.0

/**
 * What the settings rail holds for THIS caller. The shell, the rail and the
 * index redirect all read it, so the overlay never opens on a page its own
 * menu does not list.
 */
import { useCanReach } from "../../hooks/use-can-reach";
import { usePermissions } from "../../hooks/use-permissions";
import { visibleSettingsSections, type UnifiedSettingsSection } from "./navigation";

export function useSettingsSections(): UnifiedSettingsSection[] {
  const canReach = useCanReach();
  const { can } = usePermissions();
  return visibleSettingsSections({ canReach, can });
}
