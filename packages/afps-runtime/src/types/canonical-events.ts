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
 * True when the event's `type` is one of the canonical strings AND its
 * payload satisfies the canonical shape. Returns `false` for tampered
 * payloads (e.g. `memory.added` without a string `content`) so callers
 * can fall back to the open-envelope branch instead of trusting an
 * ill-formed event.
 *
 * Performs **structural** checks only — no deep clone, no mutation.
 *
 * ## Relationship to the published payload schemas
 *
 * This guard is the gate `buildCloudEventEnvelope` uses to decide whether
 * to stamp the CloudEvents `dataschema` attribute, so it MUST NOT accept
 * anything the schema at that URI would reject. It therefore mirrors every
 * constraint in `../events/canonical-event-schemas.ts` field for field —
 * including the ones a reader might dismiss as cosmetic (`data` on
 * `appstrate.progress`/`error` must be an object; each `usage` counter and
 * `durationMs` on `appstrate.metric` must be a number).
 *
 * The one deliberate asymmetry is non-finite numbers: the guard rejects
 * them (see {@link isWireNumber}) where an in-memory ajv run would accept
 * them. That direction is safe — rejecting more than the schema only costs
 * an omitted OPTIONAL attribute — and it matches what survives
 * serialization. The shared fixture corpus
 * (`test/fixtures/canonical-event-corpus.ts`) pins the equality on every
 * other constrained field, and a coverage assertion derived from the
 * generated JSON Schema documents fails if a new constrained field appears
 * without a fixture exercising it.
 */
export function isCanonicalRunEvent(event: RunEvent): event is CanonicalRunEvent {
  if (!CANONICAL_TYPE_SET.has(event.type)) return false;
  switch (event.type) {
    case "memory.added": {
      const e = event as Record<string, unknown>;
      if (typeof e.content !== "string") return false;
      return isValidScope(e.scope);
    }
    case "pinned.set": {
      const e = event as Record<string, unknown>;
      if (typeof e.key !== "string" || e.key.length === 0) return false;
      // `content` is `required` in the published schema. An explicit
      // `undefined` is dropped by `JSON.stringify`, so it is absent on the
      // wire — `!== undefined`, not `"content" in e`.
      if (e.content === undefined) return false;
      return isValidScope(e.scope);
    }
    case "output.emitted":
      return (event as Record<string, unknown>).data !== undefined;
    case "log.written": {
      const e = event as Record<string, unknown>;
      return (
        (e.level === "info" || e.level === "warn" || e.level === "error") &&
        typeof e.message === "string"
      );
    }
    case "appstrate.progress":
    case "appstrate.error": {
      const e = event as Record<string, unknown>;
      if (typeof e.message !== "string") return false;
      // Optional structured context: `Record<string, unknown>` in the
      // schema, so an array / null / scalar is a violation.
      if (e.data !== undefined && !isJsonObject(e.data)) return false;
      return true;
    }
    case "appstrate.metric": {
      const e = event as Record<string, unknown>;
      // usage, cost and durationMs are all optional; when present each
      // must match the published payload schema exactly.
      if (e.usage !== undefined) {
        if (!isJsonObject(e.usage)) return false;
        for (const counter of TOKEN_USAGE_COUNTERS) {
          const value = e.usage[counter];
          if (value !== undefined && !isWireNumber(value)) return false;
        }
      }
      if (e.cost !== undefined && (!isWireNumber(e.cost) || e.cost < 0)) return false;
      if (e.durationMs !== undefined && !isWireNumber(e.durationMs)) return false;
      return true;
    }
    default:
      return false;
  }
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
 * `../events/canonical-event-schemas.ts`; they moved here with the table's
 * removal because they were never about the published schemas — they guard the
 * live structural guard, which is now the sole definition of the payload shape.
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
