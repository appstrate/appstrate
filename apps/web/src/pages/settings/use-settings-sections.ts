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
import { useSpaces } from "../../hooks/use-spaces";
import { visibleSettingsSections, type UnifiedSettingsSection } from "./navigation";

/** Writing any package type, which is what installing one into a space is for. */
const PACKAGE_AUTHORING = [
  "agents:write",
  "skills:write",
  "mcp-servers:write",
  "integrations:install",
];

export function useSettingsSections(): UnifiedSettingsSection[] {
  const { can } = usePermissions();
  const { features } = useAppConfig();
  const { data: applications = [] } = useSpaces();

  // Authoring rights are per space, and the library crosses every space the
  // caller can enter: it is offered when ANY of them grants one.
  const canAuthorPackage = applications.some((space) =>
    PACKAGE_AUTHORING.some((permission) => space.permissions.includes(permission)),
  );

  return visibleSettingsSections({
    can,
    canAuthorPackage,
    features: {
      oidc: !!features.oidc,
      billing: !!features.billing,
      webhooks: !!features.webhooks,
    },
  });
}
