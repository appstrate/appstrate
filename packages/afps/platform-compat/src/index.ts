// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate contributors

/**
 * `@afps/platform-compat` — bundle-compat shim for pre-1.3 agents.
 *
 * In AFPS 1.3 the five reserved platform tools (add_memory, set_state,
 * output, report, log) become regular `dependencies.tools[]` packages.
 * Agents built against pre-1.3 schemas never declare those dependencies;
 * they assume the runtime injects the tools implicitly.
 *
 * A runner can auto-inject this package's `PLATFORM_TOOLS` into the
 * tool set whenever it loads a bundle with `schemaVersion` < 1.3, so
 * those agents keep running unchanged.
 *
 * Native 1.3 bundles that declare `@afps/memory`, `@afps/state`, etc.
 * directly should NOT use this package — they already ship the tools.
 */

import type { Tool } from "@afps/types";

import memoryTool from "@afps/memory";
import stateTool from "@afps/state";
import outputTool from "@afps/output";
import reportTool from "@afps/report";
import logTool from "@afps/log";

export const PLATFORM_TOOLS: Record<string, Tool> = {
  add_memory: memoryTool,
  set_state: stateTool,
  output: outputTool,
  report: reportTool,
  log: logTool,
};

export { memoryTool, stateTool, outputTool, reportTool, logTool };
