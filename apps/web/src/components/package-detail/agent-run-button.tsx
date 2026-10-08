// SPDX-License-Identifier: Apache-2.0

import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { RunAgentButton } from "../run-agent-button";
import { usePackageDetail } from "../../hooks/use-packages";
import { useAgentRunBlocker } from "../../hooks/use-agent-readiness";
import { useAgentConnectionReadiness } from "../../hooks/use-integrations";

/** The launch control of the agent page: header and empty runs list render this one. */
export function AgentRunButton({
  packageId,
  versionLabel,
  ...look
}: {
  packageId: string;
  versionLabel: string | undefined;
} & Pick<ComponentProps<typeof RunAgentButton>, "variant" | "size" | "className">) {
  const { t } = useTranslation("agents");
  const { data: detail } = usePackageDetail("agent", packageId);
  const blocker = useAgentRunBlocker(packageId, detail);
  // The same server resolver as the launch's 409. Each integration says whether
  // it blocks the run, so a switched-off agent is not read as a connection gap.
  const { data: connections } = useAgentConnectionReadiness(packageId);
  const connectionGap = connections?.integrations.some((entry) => entry.run_blocking) ?? false;

  if (!detail) return null;

  return (
    <RunAgentButton
      packageId={packageId}
      detail={detail}
      version={versionLabel}
      disabled={blocker !== null}
      disabledTitle={blocker ? t(blocker) : undefined}
      // A connection gap warns, it does not block: the launch answers it (409 modal).
      connectionWarning={blocker === null && connectionGap}
      showLabel
      {...look}
    />
  );
}
