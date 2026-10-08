// SPDX-License-Identifier: Apache-2.0

import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import i18n from "../i18n";
import { authStore } from "../stores/auth-store";
import { useCachedIntegrationName } from "./use-integrations";
import { usePermissions } from "./use-permissions";
import { useCanReach } from "./use-can-reach";
import { packageDetailPath } from "../lib/package-paths";
import {
  isViewersLaunch,
  launchWarningsToast,
  type LaunchTarget,
  type LaunchWarning,
} from "../lib/launch-warnings";

/**
 * Says, once per launch or schedule write, which integrations the run starts without. Non
 * blocking: the run is already created. "Connecter" opens the agent's Connexions tab, whose
 * pickers hold the VIEWER's connections — so it is offered only when the run is theirs.
 */
export function useLaunchWarningsToast() {
  const navigate = useNavigate();
  const nameOf = useCachedIntegrationName();
  const { can } = usePermissions();
  const canReach = useCanReach();
  return (target: LaunchTarget, agentPackageId: string, warnings: readonly LaunchWarning[]) => {
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
              label: i18n.t("launchWarnings.connect", { ns: "agents" }),
              onClick: () => navigate(`${agentPath}#connections`),
            },
          }
        : {}),
    });
  };
}
