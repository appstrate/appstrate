// Copyright 2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime tools catalog — the closed set of first-party tools the agent
 * runtime injects in-process (formerly the `@appstrate/{output,log,note,
 * pin,report}` `tool` packages, now baked into the runtime image).
 *
 * `output` is MANDATORY: it materialises the run result and is always
 * injected regardless of selection. The remaining tools are opt-in per
 * agent via the manifest's top-level `runtimeTools: string[]` field —
 * the editor renders this catalog as a checklist and the runner filters
 * the built-in factories by the selection.
 *
 * This is the single source of truth shared by:
 *   - `@appstrate/core/validation` — the `runtimeTools` enum
 *   - the agent editor (checklist labels)
 *   - the runner (`packages/runner-pi` built-in factory filter)
 */

/** Tools always injected, not selectable (materialise the run result). */
export const MANDATORY_RUNTIME_TOOLS = ["output"] as const;

/** Opt-in tools selectable per agent via `manifest.runtimeTools`. */
export const SELECTABLE_RUNTIME_TOOLS = ["log", "note", "pin", "report"] as const;

/** A tool the agent author may enable/disable. */
export type SelectableRuntimeTool = (typeof SELECTABLE_RUNTIME_TOOLS)[number];

/** Every runtime tool id (mandatory + selectable). */
export const ALL_RUNTIME_TOOLS = [...MANDATORY_RUNTIME_TOOLS, ...SELECTABLE_RUNTIME_TOOLS] as const;

/** Union of every runtime tool id. */
export type RuntimeToolName = (typeof ALL_RUNTIME_TOOLS)[number];

/** Catalog entry presented in the agent editor. */
export interface RuntimeToolCatalogEntry {
  readonly id: RuntimeToolName;
  readonly displayName: string;
  readonly description: string;
  /** When true, the tool is always injected and cannot be unselected. */
  readonly mandatory: boolean;
}

/** Display metadata for every runtime tool, in listing order. */
export const RUNTIME_TOOL_CATALOG: readonly RuntimeToolCatalogEntry[] = [
  {
    id: "output",
    displayName: "Output",
    description: "Return data as the run result.",
    mandatory: true,
  },
  {
    id: "log",
    displayName: "Log",
    description: "Send progress messages to the user in real time.",
    mandatory: false,
  },
  {
    id: "note",
    displayName: "Note",
    description: "Append a long-term archive memory, recalled on demand via recall_memory.",
    mandatory: false,
  },
  {
    id: "pin",
    displayName: "Pin",
    description: "Upsert a named slot pinned into the system prompt on every run.",
    mandatory: false,
  },
  {
    id: "report",
    displayName: "Report",
    description: "Append markdown content to the run report.",
    mandatory: false,
  },
];

/** Type guard: is `value` a selectable runtime tool id? */
export function isSelectableRuntimeTool(value: unknown): value is SelectableRuntimeTool {
  return (
    typeof value === "string" && (SELECTABLE_RUNTIME_TOOLS as readonly string[]).includes(value)
  );
}
