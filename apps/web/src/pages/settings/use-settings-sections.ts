// SPDX-License-Identifier: Apache-2.0

/**
 * What the settings rail holds for THIS caller.
 *
 * The shell and the entry redirect must agree on it: an overlay that opens on
 * a page its own menu does not list is how a guest ended up reading the
 * organisation's general settings.
 */
import { useAppConfig } from "../../hooks/use-app-config";
import { usePermissions } from "../../hooks/use-permissions";
import { visibleSettingsSections, type UnifiedSettingsSection } from "./navigation";

export function useSettingsSections(): UnifiedSettingsSection[] {
  const { can } = usePermissions();
  const { features } = useAppConfig();

  return visibleSettingsSections({
    can,
    features: {
      oidc: !!features.oidc,
      billing: !!features.billing,
      webhooks: !!features.webhooks,
    },
  });
}
