// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * The single fixture corpus for the canonical-event contract.
 *
 * `isCanonicalRunEvent` (`src/types/canonical-events.ts`) is the runtime
 * structural guard that narrows an open `RunEvent` into the discriminated
 * union AND gates the CloudEvents `dataschema` attribute. This corpus is the
 * only list of accept/reject cases for it; `test/types/canonical-events.test.ts`
 * runs every fixture through the guard and asserts the `valid` label.
 *
 * A second reader used to exist — the JSON Schema documents generated from a
 * Zod payload table in `src/events/canonical-event-schemas.ts`, run through
 * ajv — and the corpus was unified so the two could not restate each other.
 * That generator has been removed: its artifacts were never published to the
 * `$id` hosts (404, see that module), so it guarded a shape nobody could read.
 * The guard is now the sole definition.
 *
 * ## `violates`
 *
 * A fixture that puts a **wrong-typed value** at a field names that field in
 * `violates`. This used to drive a mechanical coverage guard: the schema suite
 * derived the constrained field paths from the generated documents (every
 * subschema carrying `type` or `enum`) and failed unless each was named by a
 * fixture — which is how `durationMs`, `usage`'s inner counters and
 * `progress`/`error`'s `data` were caught going un-exercised. With no
 * machine-readable schema left, that set cannot be derived, and hand-writing it
 * would recreate exactly the maintained-by-inspection list the guard replaced.
 * `violates` is therefore documentation now: it says which constraint a fixture
 * is there to exercise, so adding a constraint to the guard means adding a
 * fixture that names it.
 *
 * Omission fixtures (a missing required field) deliberately carry no
 * `violates`: they exercise presence, not the field's type constraint.
 */

import type { RunEvent } from "@afps-spec/types";

const base = { timestamp: 1, runId: "r1" };

export interface CanonicalEventFixture {
  /** Human-readable label, surfaced in assertion diffs. */
  readonly label: string;
  readonly event: RunEvent;
  /** Expected verdict from `isCanonicalRunEvent`. */
  readonly valid: boolean;
  /**
   * Dotted path (within the CloudEvent `data` projection) at which this
   * fixture places a wrong-typed value. Documents which constraint the
   * fixture exercises — see the module doc.
   */
  readonly violates?: string;
}

/**
 * Every fixture whose `type` IS canonical. Third-party types live in
 * {@link NON_CANONICAL_EVENTS} — the guard cannot know their shape.
 */
export const CANONICAL_EVENT_CORPUS: readonly CanonicalEventFixture[] = [
  // --- memory.added ---------------------------------------------------
  {
    label: "memory.added — minimal",
    event: { ...base, type: "memory.added", content: "hello" },
    valid: true,
  },
  {
    label: "memory.added — explicit shared scope",
    event: { ...base, type: "memory.added", content: "scoped", scope: "shared" },
    valid: true,
  },
  {
    label: "memory.added — explicit actor scope",
    event: { ...base, type: "memory.added", content: "scoped", scope: "actor" },
    valid: true,
  },
  {
    label: "memory.added — missing content",
    event: { ...base, type: "memory.added" },
    valid: false,
  },
  {
    label: "memory.added — numeric content",
    event: { ...base, type: "memory.added", content: 42 },
    valid: false,
    violates: "content",
  },
  {
    label: "memory.added — unknown scope",
    event: { ...base, type: "memory.added", content: "x", scope: "global" },
    valid: false,
    violates: "scope",
  },

  // --- pinned.set -----------------------------------------------------
  {
    label: "pinned.set — checkpoint slot",
    event: { ...base, type: "pinned.set", key: "checkpoint", content: { counter: 1 } },
    valid: true,
  },
  {
    label: "pinned.set — named slot, scalar content",
    event: { ...base, type: "pinned.set", key: "persona", content: "agent A" },
    valid: true,
  },
  {
    label: "pinned.set — explicit actor scope",
    event: { ...base, type: "pinned.set", key: "checkpoint", content: { c: 2 }, scope: "actor" },
    valid: true,
  },
  {
    label: "pinned.set — null content is still a value",
    event: { ...base, type: "pinned.set", key: "k", content: null },
    valid: true,
  },
  {
    label: "pinned.set — missing key",
    event: { ...base, type: "pinned.set", content: 1 },
    valid: false,
  },
  {
    label: "pinned.set — missing content",
    event: { ...base, type: "pinned.set", key: "checkpoint" },
    valid: false,
  },
  {
    // `JSON.stringify` drops an explicitly-undefined value, so the wire
    // payload is `{"key":"k"}` — which fails `required: ["content"]`.
    label: "pinned.set — explicitly undefined content",
    event: { ...base, type: "pinned.set", key: "k", content: undefined },
    valid: false,
  },
  {
    label: "pinned.set — numeric key",
    event: { ...base, type: "pinned.set", key: 42, content: 1 },
    valid: false,
    violates: "key",
  },
  {
    label: "pinned.set — empty key",
    event: { ...base, type: "pinned.set", key: "", content: 1 },
    valid: false,
  },
  {
    label: "pinned.set — unknown scope",
    event: { ...base, type: "pinned.set", key: "k", content: 1, scope: "everyone" },
    valid: false,
    violates: "scope",
  },

  // --- output.emitted -------------------------------------------------
  {
    label: "output.emitted — object payload",
    event: { ...base, type: "output.emitted", data: { ok: true } },
    valid: true,
  },
  {
    label: "output.emitted — null payload is still a value",
    event: { ...base, type: "output.emitted", data: null },
    valid: true,
  },
  {
    label: "output.emitted — missing data",
    event: { ...base, type: "output.emitted" },
    valid: false,
  },
  {
    label: "output.emitted — explicitly undefined data",
    event: { ...base, type: "output.emitted", data: undefined },
    valid: false,
  },

  // --- log.written ----------------------------------------------------
  {
    label: "log.written — info line",
    event: { ...base, type: "log.written", level: "info", message: "x" },
    valid: true,
  },
  {
    label: "log.written — unknown level",
    event: { ...base, type: "log.written", level: "debug", message: "x" },
    valid: false,
    violates: "level",
  },
  {
    label: "log.written — missing message",
    event: { ...base, type: "log.written", level: "info" },
    valid: false,
  },
  {
    label: "log.written — numeric message",
    event: { ...base, type: "log.written", level: "warn", message: 42 },
    valid: false,
    violates: "message",
  },

  // --- appstrate.progress ---------------------------------------------
  {
    label: "appstrate.progress — breadcrumb",
    event: { ...base, type: "appstrate.progress", message: "running" },
    valid: true,
  },
  {
    label: "appstrate.progress — with structured context",
    event: { ...base, type: "appstrate.progress", message: "running", data: { step: 2 } },
    valid: true,
  },
  {
    label: "appstrate.progress — missing message",
    event: { ...base, type: "appstrate.progress" },
    valid: false,
  },
  {
    label: "appstrate.progress — numeric message",
    event: { ...base, type: "appstrate.progress", message: 42 },
    valid: false,
    violates: "message",
  },
  {
    label: "appstrate.progress — string data",
    event: { ...base, type: "appstrate.progress", message: "m", data: "str" },
    valid: false,
    violates: "data",
  },
  {
    label: "appstrate.progress — null data",
    event: { ...base, type: "appstrate.progress", message: "m", data: null },
    valid: false,
    violates: "data",
  },

  // --- appstrate.error -------------------------------------------------
  {
    label: "appstrate.error — fatal error",
    event: { ...base, type: "appstrate.error", message: "boom" },
    valid: true,
  },
  {
    label: "appstrate.error — with structured context",
    event: { ...base, type: "appstrate.error", message: "boom", data: { code: "E1" } },
    valid: true,
  },
  {
    label: "appstrate.error — missing message",
    event: { ...base, type: "appstrate.error" },
    valid: false,
  },
  {
    label: "appstrate.error — numeric message",
    event: { ...base, type: "appstrate.error", message: 42 },
    valid: false,
    violates: "message",
  },
  {
    label: "appstrate.error — numeric data",
    event: { ...base, type: "appstrate.error", message: "m", data: 42 },
    valid: false,
    violates: "data",
  },
  {
    label: "appstrate.error — array data",
    event: { ...base, type: "appstrate.error", message: "m", data: [] },
    valid: false,
    violates: "data",
  },

  // --- appstrate.metric ------------------------------------------------
  {
    label: "appstrate.metric — empty payload (runner with no LLM traffic)",
    event: { ...base, type: "appstrate.metric" },
    valid: true,
  },
  {
    label: "appstrate.metric — durationMs only",
    event: { ...base, type: "appstrate.metric", durationMs: 1234 },
    valid: true,
  },
  {
    label: "appstrate.metric — usage + cost",
    event: {
      ...base,
      type: "appstrate.metric",
      usage: { input_tokens: 10, output_tokens: 5 },
      cost: 0.01,
    },
    valid: true,
  },
  {
    label: "appstrate.metric — every counter populated",
    event: {
      ...base,
      type: "appstrate.metric",
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 4,
      },
      cost: 0,
      durationMs: 0,
    },
    valid: true,
  },
  {
    label: "appstrate.metric — scalar usage",
    event: { ...base, type: "appstrate.metric", usage: 42 },
    valid: false,
    violates: "usage",
  },
  {
    label: "appstrate.metric — array usage",
    event: { ...base, type: "appstrate.metric", usage: [] },
    valid: false,
    violates: "usage",
  },
  {
    label: "appstrate.metric — string input_tokens",
    event: { ...base, type: "appstrate.metric", usage: { input_tokens: "5" } },
    valid: false,
    violates: "usage.input_tokens",
  },
  {
    label: "appstrate.metric — null output_tokens",
    event: { ...base, type: "appstrate.metric", usage: { output_tokens: null } },
    valid: false,
    violates: "usage.output_tokens",
  },
  {
    label: "appstrate.metric — array cache_creation_input_tokens",
    event: {
      ...base,
      type: "appstrate.metric",
      usage: { cache_creation_input_tokens: [] },
    },
    valid: false,
    violates: "usage.cache_creation_input_tokens",
  },
  {
    label: "appstrate.metric — object cache_read_input_tokens",
    event: {
      ...base,
      type: "appstrate.metric",
      usage: { cache_read_input_tokens: {} },
    },
    valid: false,
    violates: "usage.cache_read_input_tokens",
  },
  {
    label: "appstrate.metric — negative cost",
    event: { ...base, type: "appstrate.metric", cost: -1 },
    valid: false,
    violates: "cost",
  },
  {
    label: "appstrate.metric — string cost",
    event: { ...base, type: "appstrate.metric", cost: "0.5" },
    valid: false,
    violates: "cost",
  },
  {
    label: "appstrate.metric — string durationMs",
    event: { ...base, type: "appstrate.metric", durationMs: "later" },
    valid: false,
    violates: "durationMs",
  },
  {
    label: "appstrate.metric — array durationMs alongside a valid cost",
    event: { ...base, type: "appstrate.metric", cost: 0.5, durationMs: [] },
    valid: false,
    violates: "durationMs",
  },
];

/**
 * Event types outside the canonical vocabulary. `isCanonicalRunEvent` must
 * reject all of them; there is no published schema to compare against, so
 * they are kept out of {@link CANONICAL_EVENT_CORPUS}.
 */
export const NON_CANONICAL_EVENTS: readonly { label: string; event: RunEvent }[] = [
  {
    label: "third-party namespaced type",
    event: { ...base, type: "@my-org/audit.logged", payload: 1 },
  },
  {
    label: "runtime-internal tool event",
    event: { ...base, type: "api_call.called", method: "GET" },
  },
  {
    // `report.appended` was canonical until the report tool was retired in
    // favour of durable `outputs/` documents — a stale emitter is now
    // third-party as far as the runtime is concerned.
    label: "retired report.appended",
    event: { ...base, type: "report.appended", content: "# Report" },
  },
  { label: "Object.prototype key as type", event: { ...base, type: "constructor" } },
];

/**
 * The ONE place guard and schema deliberately disagree.
 *
 * `NaN` / `±Infinity` are `number`s in JS, so an in-memory ajv run against
 * `{"type":"number"}` accepts them — but `JSON.stringify` turns them into
 * `null`, which the same schema rejects on the wire. The guard therefore
 * rejects them, which is the safe direction: it can only cost an omitted
 * OPTIONAL `dataschema`, never a false one.
 *
 * These fixtures are excluded from {@link CANONICAL_EVENT_CORPUS} because
 * they have no single verdict; both test files assert the divergence
 * explicitly instead.
 */
export const NON_FINITE_DIVERGENCES: readonly { label: string; event: RunEvent }[] = [
  {
    label: "appstrate.metric — Infinity cost",
    event: { ...base, type: "appstrate.metric", cost: Number.POSITIVE_INFINITY },
  },
  {
    label: "appstrate.metric — NaN durationMs",
    event: { ...base, type: "appstrate.metric", durationMs: Number.NaN },
  },
  {
    label: "appstrate.metric — Infinity input_tokens",
    event: {
      ...base,
      type: "appstrate.metric",
      usage: { input_tokens: Number.POSITIVE_INFINITY },
    },
  },
];
