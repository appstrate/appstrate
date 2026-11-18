// SPDX-License-Identifier: Apache-2.0

import { PackageActionsDropdown } from "./package-actions-dropdown";
import { useAgentActions, type AgentActionsProps } from "./use-agent-actions";

/** The agent page's Actions menu (`useAgentActions`) and the dialogs it opens. */
export function AgentActions(props: AgentActionsProps) {
  const { dropdown, dialogs } = useAgentActions(props);
  if (!dropdown) return null;
  return (
    <>
      <PackageActionsDropdown {...dropdown} />
      {dialogs}
    </>
  );
}
