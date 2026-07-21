// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Registry of runtime-injected tools — tools the runtime container
 * wires outside the AFPS bundle dependency tree (the integration
 * `{ns}__api_call` tool is NOT here; it is bundle-driven and lives in
 * `api-call-bridge.ts`).
 *
 * Each tool is a self-contained directory with `tool.ts` (descriptor).
 * The descriptor's `description` is the LLM-facing doc — surfaced via
 * MCP `tools/list`, never injected into the prompt. Adding a
 * runtime-injected tool means:
 *
 *   1. Create `<tool-slug>/tool.ts` exporting a `RuntimeInjectedTool`.
 *   2. Add the import + array entry below.
 *
 * No edits anywhere else — the registration loop in
 * `runtime-pi/mcp/direct.ts:buildMcpDirectFactories` iterates this array.
 */

import { runHistoryTool } from "./run-history/tool.ts";
import { recallMemoryTool } from "./recall-memory/tool.ts";
import { desktopBrowserTool } from "./desktop-browser/tool.ts";

export type { RuntimeInjectedTool } from "./types.ts";

export { runHistoryTool as RUN_HISTORY_INJECTED_TOOL };
export { recallMemoryTool as RECALL_MEMORY_INJECTED_TOOL };
export { desktopBrowserTool as DESKTOP_BROWSER_INJECTED_TOOL };

/**
 * Canonical list of runtime-injected tools, in the order they should
 * appear in the `### Tools` listing and `toolDocs` block.
 *
 * Order rationale: `run_history` first (pure metadata, read-only),
 * `recall_memory` second (pairs with the built-in `note` tool),
 * `desktop_browser` last (side-effecting, and only usable when the run
 * owner has the desktop companion connected).
 */
export const RUNTIME_INJECTED_TOOLS = [
  runHistoryTool,
  recallMemoryTool,
  desktopBrowserTool,
] as const;
