// SPDX-License-Identifier: Apache-2.0

/**
 * Report Tool — Generate a markdown report as part of the run result.
 *
 * Each call appends content to the final report (separated by double
 * newlines). The platform renders the accumulated markdown in a dedicated
 * "Report" tab visible to the user.
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "report",
    label: "Report",
    description:
      "MANDATORY — call at least once before finishing. Appends markdown content to the run report. " +
      "Each call appends to the report (separated by newlines). Use markdown formatting for structure.",
    parameters: Type.Object({
      content: Type.String({ description: "Markdown content to append to the report" }),
    }),

    async execute(_toolCallId, params) {
      const { content } = params as { content: string };
      emit({ type: "report", content });
      return {
        content: [{ type: "text", text: "Report content recorded" }],
        details: { content },
      };
    },
  });
}
