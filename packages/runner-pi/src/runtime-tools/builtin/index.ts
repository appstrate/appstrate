// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Built-in runtime tool factories — the former `@appstrate/{output,log,
 * note,pin,report}` tool packages, baked into the runtime image after the
 * `tool` package type was removed.
 *
 * Every tool is opt-in per agent via the manifest's `runtimeTools: string[]`
 * field — none is auto-injected. {@link selectBuiltinRuntimeToolFactories}
 * resolves the manifest selection into the concrete factory set the runner
 * registers with the Pi SDK. `output` materialises the run result; core
 * validation requires it to be selected only when the agent declares an
 * output schema.
 *
 * The selectable list MUST stay in sync with `SELECTABLE_RUNTIME_TOOLS`
 * in `@appstrate/core/runtime-tools-catalog` (the validation + editor
 * source of truth). A drift is caught by `runtime-tools/builtin` tests.
 * The lists are duplicated here rather than imported so this published,
 * dependency-light runner package does not take a hard `@appstrate/core`
 * dependency.
 */

import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

import { outputTool } from "./output.ts";
import { logTool } from "./log.ts";
import { noteTool } from "./note.ts";
import { pinTool } from "./pin.ts";
import { reportTool } from "./report.ts";

/** Opt-in tools selectable per agent via `manifest.runtimeTools`. */
export const SELECTABLE_RUNTIME_TOOLS = ["output", "log", "note", "pin", "report"] as const;

export type BuiltinRuntimeToolName = (typeof SELECTABLE_RUNTIME_TOOLS)[number];

/** Every built-in runtime tool, keyed by its catalog id. */
export const BUILTIN_RUNTIME_TOOL_FACTORIES: Record<BuiltinRuntimeToolName, ExtensionFactory> = {
  output: outputTool,
  log: logTool,
  note: noteTool,
  pin: pinTool,
  report: reportTool,
};

function isSelectable(value: string): value is BuiltinRuntimeToolName {
  return (SELECTABLE_RUNTIME_TOOLS as readonly string[]).includes(value);
}

/**
 * Resolve a manifest's `runtimeTools` selection into the factories to
 * register. Every tool is opt-in: a factory is added only when its id is
 * present in the selection. Unknown entries are ignored here (install-time
 * validation rejects them upstream).
 */
export function selectBuiltinRuntimeToolFactories(
  runtimeTools: readonly string[] | undefined,
): { id: BuiltinRuntimeToolName; factory: ExtensionFactory }[] {
  const ids = new Set<BuiltinRuntimeToolName>();
  for (const entry of runtimeTools ?? []) {
    if (isSelectable(entry)) ids.add(entry);
  }
  return [...ids].map((id) => ({ id, factory: BUILTIN_RUNTIME_TOOL_FACTORIES[id] }));
}
