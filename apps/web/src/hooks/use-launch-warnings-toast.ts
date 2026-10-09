// SPDX-License-Identifier: Apache-2.0

import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import i18n from "../i18n";
import { authStore } from "../stores/auth-store";
import { useIntegrationNames } from "./use-integrations";
import { usePermissions } from "./use-permissions";
import { useCanReach } from "./use-can-reach";
import { packageDetailPath } from "../lib/package-paths";
import {
  hasLaunchWarnings,
  isViewersLaunch,
  launchWarningsToast,
  type LaunchTarget,
  type LaunchWarning,
} from "../lib/launch-warnings";

/**
 * Toasts which integrations a launch or schedule write starts without, once their names are
 * known (fire-and-forget). "Connecter" opens the Connexions tab, whose pickers hold the
 * VIEWER's connections: offered only when the run is theirs.
 */
export function useLaunchWarningsToast() {
  const navigate = useNavigate();
  const integrationNames = useIntegrationNames();
  const { can } = usePermissions();
  const canReach = useCanReach();
  return (target: LaunchTarget, agentPackageId: string, warnings: readonly LaunchWarning[]) => {
    // Checked first: a launch without warnings costs no name lookup.
    if (!hasLaunchWarnings(warnings)) return;
    void integrationNames().then((nameOf) => {
      const content = launchWarningsToast({ kind: target.kind, warnings, nameOf });
      if (!content) return;
      const agentPath = packageDetailPath("agent", agentPackageId);
      const canConnect =
        content.connectable &&
        isViewersLaunch(target, authStore.getState().user?.id) &&
        can("integrations:read") &&
        canReach(agentPath);
      toast.warning(content.message, {
        description: content.description,
        ...(canConnect
          ? {
              action: {
                label: i18n.t("detail.integrationConnect", { ns: "agents" }),
                onClick: () => navigate(`${agentPath}#connections`),
              },
            }
          : {}),
      });
    });
  };
}
