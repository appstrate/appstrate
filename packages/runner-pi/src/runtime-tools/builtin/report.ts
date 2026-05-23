// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Report built-in tool — Generate a markdown report as part of the run result.
 *
 * Formerly the `@appstrate/report` tool package; baked into the runtime
 * image. Each call appends markdown to the run report (separated by
 * newlines). Emits a `report.appended` event on stdout.
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { emit } from "./emit.ts";

export const reportTool: ExtensionFactory = (pi: ExtensionAPI) => {
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
      emit({ type: "report.appended", content });
      return {
        content: [{ type: "text", text: "Report content recorded" }],
        details: { content },
      };
    },
  });
};
