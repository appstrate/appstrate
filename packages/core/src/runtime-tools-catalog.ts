// Copyright 2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime tools catalog — the closed set of first-party tools the agent
 * runtime injects in-process (formerly the `@appstrate/{output,log,note,
 * pin,report}` `tool` packages, now baked into the runtime image).
 *
 * Every tool is opt-in per agent via the manifest's top-level
 * `runtimeTools: string[]` field — none is injected by default. The editor
 * renders this catalog as a checklist and the runner filters the built-in
 * factories by the selection. `output` materialises the run result; it is
 * only required (and enforced at save time) when the agent declares an
 * `output.schema` — see `@appstrate/core/validation`. An agent with no
 * output schema may simply perform its task and finish without it.
 *
 * This is the single source of truth shared by:
 *   - `@appstrate/core/validation` — the `runtimeTools` enum
 *   - the agent editor (checklist labels)
 *   - the runner (`packages/runner-pi` built-in factory filter)
 */

/**
 * Opt-in tools selectable per agent via `manifest.runtime_tools`. `output`
 * leads the list (it materialises the run result) but is not auto-injected;
 * validation requires it only when an output schema is declared.
 */
export const SELECTABLE_RUNTIME_TOOLS = ["output", "log", "note", "pin", "report"] as const;

/** A tool the agent author may enable/disable. */
export type SelectableRuntimeTool = (typeof SELECTABLE_RUNTIME_TOOLS)[number];

/** Catalog entry presented in the agent editor. */
export interface RuntimeToolCatalogEntry {
  readonly id: SelectableRuntimeTool;
  readonly displayName: string;
  readonly description: string;
}

/** Display metadata for every runtime tool, in listing order. */
export const RUNTIME_TOOL_CATALOG: readonly RuntimeToolCatalogEntry[] = [
  {
    id: "output",
    displayName: "Output",
    description: "Return data as the run result. Required when an output schema is defined.",
  },
  {
    id: "log",
    displayName: "Log",
    description: "Send progress messages to the user in real time.",
  },
  {
    id: "note",
    displayName: "Note",
    description: "Append a long-term archive memory, recalled on demand via recall_memory.",
  },
  {
    id: "pin",
    displayName: "Pin",
    description: "Upsert a named slot pinned into the system prompt on every run.",
  },
  {
    id: "report",
    displayName: "Report",
    description: "Append markdown content to the run report.",
  },
];

/** Type guard: is `value` a selectable runtime tool id? */
export function isSelectableRuntimeTool(value: unknown): value is SelectableRuntimeTool {
  return (
    typeof value === "string" && (SELECTABLE_RUNTIME_TOOLS as readonly string[]).includes(value)
  );
}
