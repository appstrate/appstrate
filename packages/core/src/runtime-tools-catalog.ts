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
 * `publish_file` is the odd one out: unlike the pure event emitters it
 * performs an HTTP upload of a workspace file to the platform, so it is built
 * with an injected uploader in the runtime entrypoint (not by
 * {@link buildRuntimeToolDefs}) — it is selectable (validation + editor) but
 * never appears in the standalone def builder.
 *
 * **Canonical ids only, and there is no second list.** A retired spelling does
 * not come back here under any circumstance: it is dropped on read, and the
 * drop is reported by {@link canonicalizeRuntimeToolIds} rather than swallowed.
 */
export const SELECTABLE_RUNTIME_TOOLS = [...EVENT_EMITTER_RUNTIME_TOOLS, "publish_file"] as const;

/** A tool the agent author may enable/disable. */
export type SelectableRuntimeTool = (typeof SELECTABLE_RUNTIME_TOOLS)[number];

/** Catalog entry presented in the agent editor. */
export interface RuntimeToolCatalogEntry {
  readonly id: SelectableRuntimeTool;
  readonly displayName: string;
  readonly description: string;
}

/**
 * Display metadata for the runtime tools offered in the agent editor — one
 * entry per {@link SELECTABLE_RUNTIME_TOOLS} id, no hidden members.
 */
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
    id: "publish_file",
    displayName: "Publish file",
    description: "Publish a file the agent created (e.g. an HTML report) as a durable run file.",
  },
];

// ---------------------------------------------------------------------------
// Reading stored ids
// ---------------------------------------------------------------------------

/**
 * {@link SELECTABLE_RUNTIME_TOOLS}, retyped as the non-empty MUTABLE tuple
 * `z.enum()` requires — that is the whole of the difference, and the only
 * reason this second binding exists. `[...X] as const` yields a readonly tuple,
 * which `z.enum` will not take.
 *
 * It is NOT a drift guard. The commit that removed the alias table defended
 * keeping both names on the grounds that the OpenAPI schema should import
 * ACCEPTED "so the request-body enum cannot silently become the editor's list
 * the next time the two differ". They cannot differ: this is defined as a
 * spread of that one.
 *
 * There used to be an alias table here mapping `publish_document` forward to
 * `publish_file` (#1177), kept because `runtime_tools` is persisted inside
 * agent manifests — including published ZIPs, which are immutable. It is gone:
 * no system package ships that spelling, and no stored manifest carries it.
 * A manifest that somehow did would have the id DROPPED, not silently
 * mistaken for another tool — see {@link canonicalizeRuntimeToolIds}, which
 * reports every drop to its caller.
 */
export const ACCEPTED_RUNTIME_TOOL_IDS = [...SELECTABLE_RUNTIME_TOOLS] as [
  SelectableRuntimeTool,
  ...SelectableRuntimeTool[],
];

/** Type guard: is `value` a selectable (canonical) runtime tool id? */
export function isSelectableRuntimeTool(value: unknown): value is SelectableRuntimeTool {
  return (
    typeof value === "string" && (SELECTABLE_RUNTIME_TOOLS as readonly string[]).includes(value)
  );
}

/** Outcome of {@link canonicalizeRuntimeToolIds}. */
export interface CanonicalizedRuntimeToolIds {
  /** Canonical ids, in the author's order, de-duplicated. */
  ids: SelectableRuntimeTool[];
  /** Ids the platform could not resolve at all (retired outright, or a typo). */
  dropped: string[];
  /**
   * True when {@link ids} differs from the input — a duplicate collapsed, or
   * an unknown id dropped. Callers that rewrite stored bytes use this to leave
   * an untouched manifest byte-identical.
   */
  changed: boolean;
}

/**
 * Canonicalize a raw `runtime_tools` array read from a manifest: drop ids the
 * platform does not know, collapse duplicates, and preserve the author's
 * order.
 *
 * Every drop is REPORTED in {@link CanonicalizedRuntimeToolIds.dropped} rather
 * than swallowed — that is what keeps a manifest naming a retired tool
 * runnable while still telling its caller what was removed.
 *
 * Pure and allocation-light; no Zod, no schema. The one helper every read path
 * should funnel stored ids through.
 */
export function canonicalizeRuntimeToolIds(raw: readonly unknown[]): CanonicalizedRuntimeToolIds {
  const ids: SelectableRuntimeTool[] = [];
  const dropped: string[] = [];
  const seen = new Set<SelectableRuntimeTool>();
  let changed = false;
  for (const entry of raw) {
    if (!isSelectableRuntimeTool(entry)) {
      dropped.push(String(entry));
      changed = true;
      continue;
    }
    if (seen.has(entry)) {
      changed = true;
      continue;
    }
    seen.add(entry);
    ids.push(entry);
  }
  return { ids, dropped, changed };
}
