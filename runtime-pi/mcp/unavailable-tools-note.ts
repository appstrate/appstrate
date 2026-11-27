// SPDX-License-Identifier: Apache-2.0

import { isMcpToolName } from "@appstrate/mcp-transport";
import type { IntegrationBootReport, UnavailableToolReason } from "@appstrate/core/sidecar-types";

/** A block is a decision of the space administrators, not a fault: say so, so the model does not retry. */
const reasonText = (reason: UnavailableToolReason): string =>
  reason === "blocked_in_space" ? "blocked_in_space: blocked by the space administrators" : reason;

/**
 * The system-prompt note naming the tools the agent selected that this run cannot call, so the
 * model does not plan around them. Empty when every selected tool is available.
 */
export function unavailableToolsNote(spawned: IntegrationBootReport["spawned"]): string {
  // Server-controlled names reach the system prompt: only plain tokens are quoted. Identical
  // lines (several connections of one integration, one tool) collapse.
  const lines = new Set(
    spawned.flatMap((entry) =>
      (entry.unavailableTools ?? [])
        .filter(({ name }) => isMcpToolName(name))
        // The upstream name, always: a namespaced `ns__name` could be a live sibling tool.
        .map(({ name, reason }) => `${entry.integrationId}: ${name} (${reasonText(reason)})`),
    ),
  );
  if (lines.size === 0) return "";
  return `\n\n<unavailable_tools>\n${[...lines].join("\n")}\n</unavailable_tools>`;
}
