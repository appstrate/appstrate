// SPDX-License-Identifier: Apache-2.0

import type { AgentDetail } from "@appstrate/shared-types";
import { isNeverPublishedForReader } from "../hooks/use-agent-readiness";

export function agentHasInput(agent: AgentDetail): boolean {
  const properties = agent.input?.schema?.properties;
  return !!properties && Object.keys(properties).length > 0;
}

/** A requested run opens the input form only where a click on the button would. */
export function runInputOpens({
  requested,
  disabled,
  canRun,
  detail,
}: {
  requested: boolean;
  disabled: boolean;
  canRun: boolean;
  detail: AgentDetail | undefined;
}): boolean {
  return (
    requested &&
    !disabled &&
    canRun &&
    !!detail &&
    !isNeverPublishedForReader(detail) &&
    agentHasInput(detail)
  );
}
