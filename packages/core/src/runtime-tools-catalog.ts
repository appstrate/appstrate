// Copyright 2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime tools catalog — the closed set of first-party tools the agent
 * runtime injects in-process, baked into the runtime image.
 *
 * Every tool is opt-in per agent via the manifest's top-level
 * `runtime_tools: string[]` field — none is injected by default. The editor
 * renders this catalog as a checklist. `output` is not part of this catalog: the
 * runner injects it whenever the agent declares an `output.schema`
 * (`@appstrate/core/runtime-tool-defs` `buildOutputToolDef`).
 *
 * This is the single source of truth shared by:
 *   - `@appstrate/core/validation` — the `runtime_tools` enum
 *   - the agent editor (checklist labels)
 */

/**
 * The runtime tools served by the `@appstrate/platform` system integration
 * (`appstrate_platform__log`, …): selectable ids with no builder in the runner.
 */
export const EVENT_EMITTER_RUNTIME_TOOLS = ["log", "note", "pin"] as const;

/** An event-emitter runtime tool (no injected dependency to build). */
export type EventEmitterRuntimeTool = (typeof EVENT_EMITTER_RUNTIME_TOOLS)[number];

/**
 * Opt-in tools selectable per agent via `manifest.runtime_tools`.
 *
 * `publish_file` is the odd one out: the runner registers it whenever its host
 * supplies an uploader, whatever the selection.
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
 * There used to be an alias table mapping `publish_document` forward to
 * `publish_file`, kept because `runtime_tools` is persisted inside
 * agent manifests — including published ZIPs, which are immutable. It is gone:
 * no system package ships that spelling, and no stored manifest carries it. A
 * manifest that somehow did has the id DROPPED and reported here, never
 * silently mistaken for another tool.
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
