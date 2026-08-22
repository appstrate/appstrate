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
 * **Canonical ids only.** A retired spelling never comes back here — it goes
 * in {@link LEGACY_RUNTIME_TOOL_ALIASES}, which is what keeps the editor from
 * offering it as a new choice while persisted manifests still resolve.
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
// Legacy id aliasing — the one place a retired spelling is mapped forward
// ---------------------------------------------------------------------------

/**
 * Retired `runtime_tools` spellings and the canonical id each resolves to.
 * **The single alias table in the codebase** — validation, the publish path
 * and the editor all read it from here.
 *
 * Why this exists rather than a plain rename: `runtime_tools` is persisted
 * INSIDE agent manifests, including published ZIPs that are immutable by
 * construction. The read path drops ids it does not recognise (that is what
 * keeps a manifest naming a genuinely retired tool runnable), so a bare rename
 * would not fail loudly — it would silently strip the tool from every agent
 * that already selected it, with nothing in any log. An alias turns "unknown,
 * drop it" into "known under an old name, resolve it".
 *
 * A key here is deliberately NOT in {@link SELECTABLE_RUNTIME_TOOLS} nor in
 * {@link RUNTIME_TOOL_CATALOG}: it must resolve on read and never be offered
 * as a new choice in the editor.
 *
 * `publish_document` → `publish_file`: issue #1177. "Document" promised a
 * Word/PDF; the tool takes any file the agent produced.
 */
export const LEGACY_RUNTIME_TOOL_ALIASES = Object.freeze({
  publish_document: "publish_file",
} satisfies Readonly<Record<string, SelectableRuntimeTool>>);

/** A retired `runtime_tools` spelling — a key of {@link LEGACY_RUNTIME_TOOL_ALIASES}. */
export type LegacyRuntimeToolId = keyof typeof LEGACY_RUNTIME_TOOL_ALIASES;

/** Runtime mirror of {@link LegacyRuntimeToolId}, derived from the alias table. */
export const LEGACY_RUNTIME_TOOL_IDS = Object.keys(
  LEGACY_RUNTIME_TOOL_ALIASES,
) as readonly LegacyRuntimeToolId[];

/**
 * Every `runtime_tools` id a PERSISTED manifest may legitimately carry —
 * canonical ids first, then the legacy spellings. This is the list the Zod
 * `runtime_tools` enum and the generated AFPS JSON Schema are built from, so a
 * stored manifest holding either spelling validates instead of erroring.
 *
 * Not the editor's list: that is {@link RUNTIME_TOOL_CATALOG}.
 */
export const ACCEPTED_RUNTIME_TOOL_IDS = [
  ...SELECTABLE_RUNTIME_TOOLS,
  ...LEGACY_RUNTIME_TOOL_IDS,
] as [AcceptedRuntimeToolId, ...AcceptedRuntimeToolId[]];

/** Any `runtime_tools` id a persisted manifest may carry — canonical or legacy. */
export type AcceptedRuntimeToolId = SelectableRuntimeTool | LegacyRuntimeToolId;

/** Type guard: is `value` a selectable (canonical) runtime tool id? */
export function isSelectableRuntimeTool(value: unknown): value is SelectableRuntimeTool {
  return (
    typeof value === "string" && (SELECTABLE_RUNTIME_TOOLS as readonly string[]).includes(value)
  );
}

/**
 * Resolve any accepted `runtime_tools` id — canonical or legacy — to its
 * canonical form. Returns `null` for an id the platform genuinely does not
 * know (a typo, or a tool that was removed outright rather than renamed).
 *
 * **Use this, not {@link isSelectableRuntimeTool}, whenever you are reading
 * ids that came out of storage.** `isSelectableRuntimeTool` answers "may the
 * editor offer this?"; this answers "what tool did the author mean?". Filtering
 * stored ids through the type guard is precisely the silent-drop bug this table
 * exists to prevent.
 */
export function canonicalRuntimeToolId(value: unknown): SelectableRuntimeTool | null {
  if (typeof value !== "string") return null;
  if (isSelectableRuntimeTool(value)) return value;
  return (
    (LEGACY_RUNTIME_TOOL_ALIASES as Readonly<Record<string, SelectableRuntimeTool>>)[value] ?? null
  );
}

/** Outcome of {@link canonicalizeRuntimeToolIds}. */
export interface CanonicalizedRuntimeToolIds {
  /** Canonical ids, in the author's order, de-duplicated. */
  ids: SelectableRuntimeTool[];
  /** Ids the platform could not resolve at all (retired outright, or a typo). */
  dropped: string[];
  /**
   * True when {@link ids} differs from the input — a legacy id was resolved, a
   * duplicate collapsed, or an unknown id dropped. Callers that rewrite stored
   * bytes use this to leave an untouched manifest byte-identical.
   */
  changed: boolean;
}

/**
 * Canonicalize a raw `runtime_tools` array read from a manifest: resolve legacy
 * spellings, collapse the duplicate that appears when BOTH spellings are
 * present, drop ids that resolve to nothing, and preserve the author's order.
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
    const canonical = canonicalRuntimeToolId(entry);
    if (canonical === null) {
      dropped.push(String(entry));
      changed = true;
      continue;
    }
    if (canonical !== entry) changed = true;
    if (seen.has(canonical)) {
      changed = true;
      continue;
    }
    seen.add(canonical);
    ids.push(canonical);
  }
  return { ids, dropped, changed };
}
