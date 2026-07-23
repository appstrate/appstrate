// Copyright 2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime tools catalog — the closed set of first-party tools the agent
 * runtime injects in-process (formerly the `@appstrate/{output,log,note,
 * pin}` `tool` packages, now baked into the runtime image).
 *
 * Every tool is opt-in per agent via the manifest's top-level
 * `runtime_tools: string[]` field — none is injected by default. The editor
 * renders this catalog as a checklist and the runner filters the built-in
 * factories by the selection. `output` materialises the run result; it is
 * only required (and enforced at save time) when the agent declares an
 * `output.schema` — see `@appstrate/core/validation`. An agent with no
 * output schema may simply perform its task and finish without it.
 *
 * This is the single source of truth shared by:
 *   - `@appstrate/core/validation` — the `runtime_tools` enum
 *   - the agent editor (checklist labels)
 *   - the runner (`packages/runner-pi` built-in factory filter)
 */

/**
 * The pure event-emitter runtime tools: a call returns only canonical run
 * events (`output.emitted` / `log.written` / …) under `_meta`, with no
 * side-effect. These are the tools {@link buildRuntimeToolDefs} can construct
 * standalone (sidecar MCP surface + no-sidecar Pi extensions) — they need no
 * injected dependency.
 */
export const EVENT_EMITTER_RUNTIME_TOOLS = ["output", "log", "note", "pin"] as const;

/** An event-emitter runtime tool (no injected dependency to build). */
export type EventEmitterRuntimeTool = (typeof EVENT_EMITTER_RUNTIME_TOOLS)[number];

/**
 * Opt-in tools selectable per agent via `manifest.runtime_tools`. `output`
 * leads the list (it materialises the run result) but is not auto-injected;
 * validation requires it only when an output schema is declared.
 *
 * `publish_document` is the odd one out: unlike the pure event emitters it
 * performs an HTTP upload of a workspace file to the platform, so it is built
 * with an injected uploader in the runtime entrypoint (not by
 * {@link buildRuntimeToolDefs}) — it is selectable (validation + editor) but
 * never appears in the standalone def builder.
 */
export const SELECTABLE_RUNTIME_TOOLS = [
  ...EVENT_EMITTER_RUNTIME_TOOLS,
  "publish_document",
] as const;

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
    id: "publish_document",
    displayName: "Publish document",
    description:
      "Publish a file the agent created (e.g. an HTML report) as a durable run document.",
  },
];

/** Type guard: is `value` a selectable runtime tool id? */
export function isSelectableRuntimeTool(value: unknown): value is SelectableRuntimeTool {
  return (
    typeof value === "string" && (SELECTABLE_RUNTIME_TOOLS as readonly string[]).includes(value)
  );
}
