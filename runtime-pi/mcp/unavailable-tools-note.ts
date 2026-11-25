// SPDX-License-Identifier: Apache-2.0

import { isListedToolName, parseScopedName } from "@appstrate/core/naming";
import type { IntegrationBootReport } from "@appstrate/core/sidecar-types";

/**
 * The system-prompt note naming the tools the agent selected that this run cannot call, so the
 * model does not plan around them. Empty when every selected tool is available.
 */
export function unavailableToolsNote(spawned: IntegrationBootReport["spawned"]): string {
  // Server-controlled names reach the system prompt: only plain tokens are quoted.
  const lines = spawned
    .filter((entry) => parseScopedName(entry.integrationId) !== null)
    .flatMap((entry) =>
      (entry.unavailableTools ?? [])
        .filter(({ name }) => isListedToolName(name))
        .map(({ name, reason }) => `${entry.integrationId}: ${name} (${reason})`),
    );
  if (lines.length === 0) return "";
  return `\n\n<unavailable_tools>\n${lines.join("\n")}\n</unavailable_tools>`;
}
