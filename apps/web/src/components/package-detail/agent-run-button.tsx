// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { RunAgentButton } from "../run-agent-button";
import { usePackageDetail } from "../../hooks/use-packages";
import { useAgentRunBlocker } from "../../hooks/use-agent-readiness";
import { useAgentIntegrationsReadiness } from "../../hooks/use-agent-integrations-readiness";

/**
 * The launch control of the agent page — header and empty runs list alike.
 * One component, so the two cannot disagree about whether this agent runs.
 */
export function AgentRunButton({
  packageId,
  versionLabel,
}: {
  packageId: string;
  versionLabel: string | undefined;
}) {
  const { t } = useTranslation("agents");
  const { data: detail } = usePackageDetail("agent", packageId);
  const blocker = useAgentRunBlocker(detail);
  // Launch-time integration readiness — drives the non-blocking orange badge.
  // Same server resolver as the run-kickoff 409 (see useAgentIntegrationsReadiness).
  const integrationsReady = useAgentIntegrationsReadiness(packageId);

  if (!detail) return null;

  return (
    <RunAgentButton
      packageId={packageId}
      detail={detail}
      version={versionLabel}
      disabled={blocker !== null}
      disabledTitle={blocker ? t(blocker) : undefined}
      // Integration connection gaps don't disable Run — they surface as a
      // warning badge here and the recovery modal at run-kickoff (409).
      connectionWarning={blocker === null && !integrationsReady.ready}
      showLabel
    />
  );
}
