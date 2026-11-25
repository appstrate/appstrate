// SPDX-License-Identifier: Apache-2.0

import { allocateMcpToolName, isListedToolName, parseScopedName } from "@appstrate/core/naming";
import type { IntegrationBootReport, UnavailableToolReason } from "@appstrate/core/sidecar-types";

/** A block is a decision of the space administrators, not a fault: say so, so the model does not retry. */
const reasonText = (reason: UnavailableToolReason): string =>
  reason === "blocked_in_space" ? "blocked_in_space: blocked by the space administrators" : reason;

/**
 * The system-prompt note naming the tools the agent selected that this run cannot call, so the
 * model does not plan around them. Empty when every selected tool is available.
 */
export function unavailableToolsNote(spawned: IntegrationBootReport["spawned"]): string {
  // Server-controlled names reach the system prompt: only plain tokens are quoted. Several
  // connections of one integration share a slot, so identical lines collapse.
  const lines = new Set(
    spawned
      .filter((entry) => parseScopedName(entry.integrationId) !== null)
      .flatMap((entry) => {
        const label =
          entry.connectionLabel && isListedToolName(entry.connectionLabel)
            ? ` [${entry.connectionLabel}]`
            : "";
        return (entry.unavailableTools ?? [])
          .filter(({ name }) => isListedToolName(name))
          .map(
            ({ name, reason }) =>
              `${entry.integrationId}: ${allocateMcpToolName(entry.namespace, name, () => false)}${label} (${reasonText(reason)})`,
          );
      }),
  );
  if (lines.size === 0) return "";
  return `\n\n<unavailable_tools>\n${[...lines].join("\n")}\n</unavailable_tools>`;
}
