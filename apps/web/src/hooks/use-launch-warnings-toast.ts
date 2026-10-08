// SPDX-License-Identifier: Apache-2.0

import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import i18n from "../i18n";
import { useIntegrations } from "./use-integrations";
import { usePermissions } from "./use-permissions";
import { useCanReach } from "./use-can-reach";
import { packageDetailPath } from "../lib/package-paths";
import { launchWarningsToast, type LaunchKind, type LaunchWarning } from "../lib/launch-warnings";

/**
 * Says, once per launch or schedule write, which integrations the run starts without. Non
 * blocking: the run is already created. "Connecter" opens the agent's Connexions tab, whose
 * pickers hold the connect and choose flows.
 */
export function useLaunchWarningsToast() {
  const navigate = useNavigate();
  const { data: integrations } = useIntegrations();
  const { can } = usePermissions();
  const canReach = useCanReach();
  return (kind: LaunchKind, agentPackageId: string, warnings: readonly LaunchWarning[]) => {
    const content = launchWarningsToast({
      kind,
      warnings,
      nameOf: (id) => integrations?.find((i) => i.id === id)?.manifest.display_name ?? id,
    });
    if (!content) return;
    const agentPath = packageDetailPath("agent", agentPackageId);
    const canConnect = can("integrations:read") && canReach(agentPath);
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
