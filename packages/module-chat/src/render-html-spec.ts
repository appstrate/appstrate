// SPDX-License-Identifier: Apache-2.0

/**
 * Single source of truth for the `render_html` tool's model-facing contract
 * (description + input shape). Both chat engines expose this tool but through
 * different SDKs — the `ai` `tool()` (ai-sdk path, chat-stream.ts) and the
 * Claude Agent SDK `tool()` (claude-agent/local-tools.ts) — so the tool
 * OBJECTS can't be shared, but the wording the model sees must be identical or
 * the two engines behave differently. Hoisting it here keeps them in lockstep.
 */

import { z } from "zod";

export const RENDER_HTML_DESCRIPTION =
  "Render a complete, self-contained HTML document as a live artifact shown inline to the user. " +
  "Inline CSS/JS allowed; no external network. Use for visualizations, diagrams, mockups, or small demos.";

/** Raw Zod shape (not a `z.object`) so it fits both `tool()` signatures. */
export const renderHtmlInputShape = {
  code: z.string().describe("The complete, self-contained HTML document to render."),
  title: z.string().optional().describe("Short title for the artifact."),
};
