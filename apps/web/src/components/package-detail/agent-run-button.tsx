// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { RunAgentButton } from "../run-agent-button";
import { usePackageDetail } from "../../hooks/use-packages";
import { useAgentRunBlocker } from "../../hooks/use-agent-readiness";
import { useAgentIntegrationsReadiness } from "../../hooks/use-agent-integrations-readiness";

/** The launch control of the agent page: header and empty runs list render this one. */
export function AgentRunButton({
  packageId,
  versionLabel,
}: {
  packageId: string;
  versionLabel: string | undefined;
}) {
  const { t } = useTranslation("agents");
  const { data: detail } = usePackageDetail("agent", packageId);
  const blocker = useAgentRunBlocker(packageId, detail);
  const integrationsReady = useAgentIntegrationsReadiness(packageId);

  if (!detail) return null;

  return (
    <RunAgentButton
      packageId={packageId}
      detail={detail}
      version={versionLabel}
      disabled={blocker !== null}
      disabledTitle={blocker ? t(blocker) : undefined}
      // A connection gap warns, it does not block: the launch answers it (409 modal).
      connectionWarning={blocker === null && !integrationsReady.ready}
      showLabel
    />
  );
}
