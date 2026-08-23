// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Discriminated union over the **canonical** {@link RunEvent} types the
 * runtime knows by name.
 *
 * Why this exists: `@afps-spec/types` ships {@link RunEvent} as an open
 * envelope (`type: string` + open index signature) so third-party tools
 * can emit any payload without amending the spec. That openness is
 * correct at the spec layer but defeats TypeScript exhaustiveness in
 * the runtime, where four reserved namespaces (`memory.*`, `pinned.*`,
 * `output.*`, `log.*`) carry stable, runtime-meaningful shapes.
 *
 * {@link CanonicalRunEvent} narrows those four — and the `appstrate.*`
 * platform-internal events the runner emits — into a real discriminated
 * union. Switches over `event.type` get exhaustiveness via the standard
 * `_exhaustive: never` pattern. Unknown event types fall into the open
 * envelope branch and stay typed as `RunEvent` so the sink chain can
 * still route them.
 *
 * Use {@link isCanonicalRunEvent} to project an open `RunEvent` into
 * the union; `false` means "no canonical match — handle via the open
 * envelope".
 */

import type { RunEvent } from "@afps-spec/types";
import type { TokenUsage } from "./run-result.ts";

interface BaseEnvelope {
  timestamp: number;
  runId: string;
  toolCallId?: string;
  // Match `RunEvent`'s open index signature so the discriminated
  // union remains a structural sub-type — sinks can pass a
  // `CanonicalRunEvent` anywhere a `RunEvent` is expected without a
  // cast.
  [key: string]: unknown;
}

/**
 * `@afps/memory` — `note()` tool (AFPS; replaces `add_memory()`).
 *
 * Append-only archive write. Reachable from the agent only via the
 * `recall_memory` tool — never injected into the system prompt.
 *
 * `scope` is the unified-persistence dimension:
 * - `"actor"` (default): memory belongs to the run's actor (member or end_user).
 * - `"shared"`: memory is app-wide, visible to every actor.
 *
 * Emitters MAY omit the field entirely; consumers MUST treat absent
 * `scope` as `"actor"` so the fail-safe is per-actor isolation rather
 * than cross-actor leakage.
 */
export interface MemoryAddedEvent extends BaseEnvelope {
  type: "memory.added";
  content: string;
  /** AFPS scope dimension. Defaults to `"actor"` when omitted. */
  scope?: "actor" | "shared";
}

/**
 * `@afps/pin` — `pin(key, content)` tool (AFPS; replaces
 * `set_checkpoint()`).
 *
 * Upsert-by-key into a named pinned slot. Last-write-wins per `(scope,
 * key)`. Pinned content is rendered into the system prompt on every run.
 *
 * The `checkpoint` carry-over slot is just one valid key —
 * `key === "checkpoint"`. Other keys (e.g. `"persona"`, `"goals"`) are
 * accepted and persisted but have no special semantics in the runtime
 * reducer beyond being aggregated under {@link RunResult.pinned}.
 *
 * `scope` defaults to `"actor"` (per-run-actor isolation) when omitted.
 * Agents that genuinely want app-wide pinned slots (cron-scheduled jobs,
 * single-tenant catalogues) opt in by passing `"shared"`.
 */
export interface PinnedSetEvent extends BaseEnvelope {
  type: "pinned.set";
  /** Pinned slot identifier — `"checkpoint"` is reserved for the carry-over slot. */
  key: string;
  /** Arbitrary JSON value stored under the pinned slot. */
  content: unknown;
  /** AFPS scope dimension. Defaults to `"actor"` when omitted. */
  scope?: "actor" | "shared";
}

/** `@afps/output` — `output()` tool. Replace-on-emit semantics. */
export interface OutputEmittedEvent extends BaseEnvelope {
  type: "output.emitted";
  data: unknown;
}

/** `@afps/log` — `log()` tool. */
export interface LogWrittenEvent extends BaseEnvelope {
  type: "log.written";
  level: "info" | "warn" | "error";
  message: string;
}

/** `appstrate.progress` — runner-emitted lifecycle breadcrumb (container started, runtime ready, …). */
export interface AppstrateProgressEvent extends BaseEnvelope {
  type: "appstrate.progress";
  message: string;
  data?: Record<string, unknown>;
}

/** `appstrate.error` — fatal runtime error before/after the LLM loop. */
export interface AppstrateErrorEvent extends BaseEnvelope {
  type: "appstrate.error";
  message: string;
  data?: Record<string, unknown>;
}

/**
 * `appstrate.metric` — token usage / cost / duration emitted by the runner.
 *
 * `usage` is a {@link TokenUsage} object, `cost` is a USD number, both
 * optional so a runner with no LLM traffic can still emit a metric
 * carrying just `durationMs`.
 */
export interface AppstrateMetricEvent extends BaseEnvelope {
  type: "appstrate.metric";
  /** Token usage counters; mirrors `runs.tokenUsage` JSONB shape. */
  usage?: TokenUsage;
  /** Cost in USD attributed to this segment of the run. Non-negative. */
  cost?: number;
  /** Optional wall-clock duration in milliseconds covered by this metric. */
  durationMs?: number;
}

/** Discriminated union over every canonical event the runtime owns. */
export type CanonicalRunEvent =
  | MemoryAddedEvent
  | PinnedSetEvent
  | OutputEmittedEvent
  | LogWrittenEvent
  | AppstrateProgressEvent
  | AppstrateErrorEvent
  | AppstrateMetricEvent;

/** All canonical event-type strings — useful for prefix checks. */
export const CANONICAL_EVENT_TYPES = [
  "memory.added",
  "pinned.set",
  "output.emitted",
  "log.written",
  "appstrate.progress",
  "appstrate.error",
  "appstrate.metric",
] as const satisfies ReadonlyArray<CanonicalRunEvent["type"]>;

const CANONICAL_TYPE_SET: ReadonlySet<string> = new Set<string>(CANONICAL_EVENT_TYPES);

/** Optional AFPS scope dimension — absent, or one of the two values. */
function isValidScope(value: unknown): boolean {
  return value === undefined || value === "actor" || value === "shared";
}

/**
 * A JSON object: not `null`, not an array. Mirrors JSON Schema's
 * `type: "object"`, which excludes both.
 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A number the wire can actually carry. `NaN` and `±Infinity` are
 * `number`s in JS, but `JSON.stringify` turns them into `null`, so a
 * consumer never receives the value the producer held. An event carrying
 * one is therefore NOT canonical, even though the in-memory value passes
 * a `typeof x === "number"` check.
 */
function isWireNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Counters {@link isCanonicalRunEvent} checks inside `appstrate.metric`'s
 * `usage` object. Asserted at compile time below to be exactly
 * `keyof TokenUsage`, so a counter added to (or removed from) the interface
 * cannot escape this check.
 */
export const TOKEN_USAGE_COUNTERS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
] as const;

/**
 * One structural constraint: the dotted path it reads, and the predicate the
 * value at that path must satisfy.
 *
 * Optionality lives inside the predicate (`v === undefined || …`) rather than
 * in a separate flag, so every constraint is one uniform thing to check — and
 * one uniform thing to count, which is what makes coverage derivable.
 */
interface FieldConstraint {
  readonly path: string;
  readonly holds: (value: unknown) => boolean;
}

const required = (holds: (value: unknown) => boolean) => holds;
const optional =
  (holds: (value: unknown) => boolean) =>
  (value: unknown): boolean =>
    value === undefined || holds(value);

const isString = (v: unknown): boolean => typeof v === "string";
const isPresent = (v: unknown): boolean => v !== undefined;

/**
 * The canonical payload contract, as data.
 *
 * ## Why a table and not a `switch`
 *
 * This used to be a hand-written `switch`, and the set of constrained field
 * paths could not be recovered from it without parsing TypeScript. That set is
 * what a coverage guard needs: it is how `durationMs`, `usage`'s inner
 * counters and `progress`/`error`'s `data` were once caught shipping with no
 * fixture exercising them. The guard that derived it read generated JSON
 * Schema documents; those were removed (they were never published), and with
 * them went the only machine-readable list of constraints.
 *
 * Expressing the constraints as data restores that list from the
 * implementation itself — `test/types/canonical-events.test.ts` derives it
 * with `Object.keys`, no parser and no second copy to maintain. A constraint
 * added here is a constraint the corpus is immediately required to exercise.
 *
 * ## Order is semantic
 *
 * Constraints are evaluated in declaration order and the first failure wins,
 * so a parent path MUST precede the children that assume it resolved:
 * `usage` is checked to be a JSON object before `usage.<counter>` reads
 * through it. That mirrors the short-circuit the `switch` performed, and it
 * makes "which constraint rejected this event" a well-defined question — the
 * question the coverage guard asks.
 */
export const CANONICAL_CONSTRAINTS = {
  "memory.added": [
    { path: "content", holds: required(isString) },
    { path: "scope", holds: isValidScope },
  ],
  "pinned.set": [
    { path: "key", holds: required((v) => typeof v === "string" && v.length > 0) },
    // `content` is required, but an explicit `undefined` is dropped by
    // `JSON.stringify`, so it is absent on the wire — `!== undefined`
    // rather than an `in` check.
    { path: "content", holds: required(isPresent) },
    { path: "scope", holds: isValidScope },
  ],
  "output.emitted": [{ path: "data", holds: required(isPresent) }],
  "log.written": [
    { path: "level", holds: required((v) => v === "info" || v === "warn" || v === "error") },
    { path: "message", holds: required(isString) },
  ],
  "appstrate.progress": [
    { path: "message", holds: required(isString) },
    // Optional structured context: `Record<string, unknown>`, so an array /
    // null / scalar is a violation.
    { path: "data", holds: optional(isJsonObject) },
  ],
  "appstrate.error": [
    { path: "message", holds: required(isString) },
    { path: "data", holds: optional(isJsonObject) },
  ],
  "appstrate.metric": [
    { path: "usage", holds: optional(isJsonObject) },
    // Derived from TOKEN_USAGE_COUNTERS, which is pinned to `keyof TokenUsage`
    // at compile time below: a counter added to the interface grows this table
    // on its own, and the coverage guard then demands a fixture for it.
    ...TOKEN_USAGE_COUNTERS.map((counter) => ({
      path: `usage.${counter}`,
      holds: optional(isWireNumber),
    })),
    { path: "cost", holds: optional((v) => isWireNumber(v) && v >= 0) },
    { path: "durationMs", holds: optional(isWireNumber) },
  ],
} as const satisfies Record<CanonicalRunEvent["type"], ReadonlyArray<FieldConstraint>>;

/**
 * Read a dotted path off an event. Returns `undefined` for any segment that
 * cannot be traversed (missing, `null`, scalar, array) — never throws. A
 * parent constraint has already rejected those cases by the time a child path
 * is reached, so `undefined` here is unreachable in practice; it exists so the
 * reader is total.
 */
function readPath(event: Record<string, unknown>, path: string): unknown {
  let current: unknown = event;
  for (const segment of path.split(".")) {
    if (!isJsonObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * The first constraint the event violates, or `undefined` when it satisfies
 * all of them. Exported for the coverage guard in
 * `test/types/canonical-events.test.ts`, which asks "which constraint rejected
 * this fixture" and fails when some constraint is never the answer.
 *
 * Returns `undefined` for a non-canonical `type` too — no constraints apply,
 * so none can be violated. Callers must check the type separately;
 * {@link isCanonicalRunEvent} does.
 */
export function firstViolatedConstraint(event: RunEvent): string | undefined {
  const constraints: ReadonlyArray<FieldConstraint> | undefined =
    CANONICAL_CONSTRAINTS[event.type as CanonicalRunEvent["type"]];
  if (constraints === undefined) return undefined;
  const record = event as Record<string, unknown>;
  for (const constraint of constraints) {
    if (!constraint.holds(readPath(record, constraint.path))) return constraint.path;
  }
  return undefined;
}

/**
 * True when the event's `type` is one of the canonical strings AND its
 * payload satisfies the canonical shape. Returns `false` for tampered
 * payloads (e.g. `memory.added` without a string `content`) so callers
 * can fall back to the open-envelope branch instead of trusting an
 * ill-formed event.
 *
 * Performs **structural** checks only — no deep clone, no mutation.
 *
 * ## What rides on this
 *
 * Three callers, and two of them lose data when the guard says no:
 *
 *  - `../runner/reducer.ts` narrows with it before folding an event into the
 *    `RunResult`. A rejected event is **silently dropped** — no output, no
 *    memory, no metric.
 *  - `../sinks/stdout-bridge.ts` validates what the agent prints on stdout.
 *    That is a trust boundary: untrusted container output, structurally
 *    checked before it is believed.
 *  - `../events/cloudevents.ts` no longer consults it. The `dataschema` stamp
 *    it used to gate is gone (see that module for why).
 *
 * So this is not a cosmetic classifier. Every constraint in
 * {@link CANONICAL_CONSTRAINTS} is a rejection path that discards data, and
 * the corpus is required to exercise each one.
 *
 * ## Deliberate strictness
 *
 * Non-finite numbers are rejected (see {@link isWireNumber}) — stricter than
 * a JSON Schema `type: "number"` would be, and correct in that direction:
 * `JSON.stringify` turns them into `null`, so a consumer never receives what
 * the producer held.
 */
export function isCanonicalRunEvent(event: RunEvent): event is CanonicalRunEvent {
  if (!CANONICAL_TYPE_SET.has(event.type)) return false;
  return firstViolatedConstraint(event) === undefined;
}

/** Fails to compile unless `T` is `true`. */
type Assert<T extends true> = T;

/**
 * {@link TOKEN_USAGE_COUNTERS} — the runtime list {@link isCanonicalRunEvent}
 * iterates — pinned to exactly `keyof TokenUsage`, in both directions. A
 * counter added to the interface without an entry here would be accepted
 * unchecked; one removed from the interface would leave a dead entry.
 *
 * These two assertions used to live beside the Zod payload table in
 * `../events/canonical-event-schemas.ts`; they moved here when that module was
 * removed, because they were never about the published schemas — they guard
 * {@link CANONICAL_CONSTRAINTS}, which is now the sole definition of the
 * payload shape, and which derives its `usage.*` entries from this list.
 *
 * A module-private annotation rather than an exported type alias: tsc checks
 * `Assert<>` constraints identically either way, but a *type alias* nothing
 * references trips `noUnusedLocals` (TS6196) even when the constraints hold,
 * and TS has no per-declaration suppression. Annotating a `_`-prefixed constant
 * and voiding it keeps the checks running with no public surface; the value is
 * an empty array, only its type is load-bearing.
 */
const _tokenUsageCounterParity: [
  Assert<(typeof TOKEN_USAGE_COUNTERS)[number] extends keyof TokenUsage ? true : false>,
  Assert<keyof TokenUsage extends (typeof TOKEN_USAGE_COUNTERS)[number] ? true : false>,
] = [] as never;
void _tokenUsageCounterParity;
