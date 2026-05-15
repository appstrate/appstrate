// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Registry of runtime-injected tools — tools the runtime container
 * wires outside the AFPS bundle dependency tree (provider-call is NOT
 * here; it is bundle-driven and lives in `provider-bridge.ts`).
 *
 * Layout intentionally mirrors bundle tool packages
 * (`scripts/system-packages/tool-<name>-<version>/`): each tool is a
 * self-contained directory with `tool.ts` (descriptor) + `TOOL.md`
 * (prose). Adding a runtime-injected tool means:
 *
 *   1. Create `<tool-slug>/tool.ts` exporting a `RuntimeInjectedTool`
 *      (descriptor only — no doc inlining).
 *   2. Create `<tool-slug>/TOOL.md` next to it. The platform prompt
 *      builder reads it at run time via `loadRuntimeToolDoc(tool)`,
 *      mirroring how bundle tools expose `TOOL.md` via
 *      `pkg.files.get("TOOL.md")`.
 *   3. Add the import + array entry below.
 *
 * No edits anywhere else — the registration loop in
 * `runtime-pi/mcp/direct.ts:buildMcpDirectFactories` and the
 * `availableTools` / `toolDocs` extension in the platform prompt
 * builder both iterate this array.
 */

import { runHistoryTool } from "./run-history/tool.ts";
import { recallMemoryTool } from "./recall-memory/tool.ts";

export type { RuntimeInjectedTool } from "./types.ts";
export { loadRuntimeToolDoc } from "./load-doc.ts";

export { runHistoryTool as RUN_HISTORY_INJECTED_TOOL };
export { recallMemoryTool as RECALL_MEMORY_INJECTED_TOOL };

/**
 * Canonical list of runtime-injected tools, in the order they should
 * appear in the `### Tools` listing and `toolDocs` block.
 *
 * Order rationale: `run_history` first (pure metadata, read-only),
 * `recall_memory` second (pairs with `note` from `@appstrate/note`).
 */
export const RUNTIME_INJECTED_TOOLS = [runHistoryTool, recallMemoryTool] as const;
