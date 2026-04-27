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
 * `output.*`, `log.*`) carry stable, runtime-meaningful
 * shapes.
 *
 * {@link CanonicalRunEvent} narrows those four — and the `appstrate.*`
 * platform-internal events the runner emits — into a real discriminated
 * union. Switches over `event.type` get exhaustiveness via the standard
 * `_exhaustive: never` pattern. Unknown event types fall into the open
 * envelope branch and stay typed as `RunEvent` so the sink chain can
 * still route them.
 *
 * Use {@link narrowCanonicalEvent} to project an open `RunEvent` into
 * the union; `null` means "no canonical match — handle via the open
 * envelope".
 */

import type { RunEvent } from "@afps-spec/types";
import type { RunError, TokenUsage } from "./run-result.ts";

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
 * `@afps/memory` — `note()` tool (AFPS 1.5+; replaces `add_memory()`).
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
  /** AFPS 1.4+. Defaults to `"actor"` when omitted. */
  scope?: "actor" | "shared";
}

/**
 * `@afps/pin` — `pin(key, content)` tool (AFPS 1.5+; replaces
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
  /** AFPS 1.4+. Defaults to `"actor"` when omitted. */
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

/**
 * `@appstrate/report` — `report(content)` tool.
 *
 * Append-only markdown channel for the user-facing run report. Each call
 * appends `content` to the run's accumulated report — the platform stores
 * one `run_logs` row per emit and the UI concatenates them when rendering.
 *
 * Distinct from `output.emitted`: `output` carries structured JSON
 * consumed programmatically (next step in a pipeline, schema-validated);
 * `report` carries human-readable markdown summarising what the run did.
 */
export interface ReportAppendedEvent extends BaseEnvelope {
  type: "report.appended";
  content: string;
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

/**
 * `run.started` — runtime crossed from `pending` to `running`.
 *
 * Emitted exactly once per run, on the first event POST that establishes
 * proof-of-life. Useful for webhook subscribers and audit log sinks that
 * want a discrete "starting work" signal instead of inferring it from the
 * absence of terminal events.
 *
 * Vocabulary note: terminal variants are `run.success` / `run.timeout`
 * (not `run.succeeded` / `run.timedout`) to align with `RunResult.status`,
 * the `runs.status` enum, and the existing webhook event names — the
 * reducer's terminal status comes from those columns, not a parallel set
 * of -ed names.
 */
export interface RunStartedEvent extends BaseEnvelope {
  type: "run.started";
  /** Runner topology — `"platform"` (in-container Pi runner) or `"remote"` (CLI / GitHub Action). */
  runnerKind?: "platform" | "remote";
  /** Free-form runner identifier (e.g. `"appstrate-cli@0.4.0"`, `"github-action"`). */
  runnerName?: string;
}

interface BaseRunCompletedEvent extends BaseEnvelope {
  /** Wall-clock duration of the run in milliseconds. */
  durationMs?: number;
}

/** `run.success` — terminal: run completed with `status: "success"`. */
export interface RunSucceededEvent extends BaseRunCompletedEvent {
  type: "run.success";
}

/** `run.failed` — terminal: run completed with `status: "failed"`. */
export interface RunFailedEvent extends BaseRunCompletedEvent {
  type: "run.failed";
  /**
   * Optional structured error from `RunResult.error`. Full `RunError`
   * shape (`code`, `message`, `stack`, `context`, `timestamp`) — the
   * validator (`isCanonicalRunEvent`) accepts the same fields, so a
   * runner can emit `error: result.error` directly without projection.
   * Sinks consuming `RunFailedEvent.error` get the same surface as
   * sinks consuming `RunResult.error`.
   */
  error?: RunError;
}

/** `run.timeout` — terminal: run exceeded its timeout budget. */
export interface RunTimedOutEvent extends BaseRunCompletedEvent {
  type: "run.timeout";
}

/** `run.cancelled` — terminal: run was cancelled by user or scheduler. */
export interface RunCancelledEvent extends BaseRunCompletedEvent {
  type: "run.cancelled";
  /** Free-form reason ("user_cancelled", "shutdown", …). */
  reason?: string;
}

/** Discriminated union over every canonical event the runtime owns. */
export type CanonicalRunEvent =
  | MemoryAddedEvent
  | PinnedSetEvent
  | OutputEmittedEvent
  | LogWrittenEvent
  | ReportAppendedEvent
  | AppstrateProgressEvent
  | AppstrateErrorEvent
  | AppstrateMetricEvent
  | RunStartedEvent
  | RunSucceededEvent
  | RunFailedEvent
  | RunTimedOutEvent
  | RunCancelledEvent;

/** All canonical event-type strings — useful for prefix checks. */
export const CANONICAL_EVENT_TYPES = [
  "memory.added",
  "pinned.set",
  "output.emitted",
  "log.written",
  "report.appended",
  "appstrate.progress",
  "appstrate.error",
  "appstrate.metric",
  "run.started",
  "run.success",
  "run.failed",
  "run.timeout",
  "run.cancelled",
] as const satisfies ReadonlyArray<CanonicalRunEvent["type"]>;

const CANONICAL_TYPE_SET: ReadonlySet<string> = new Set<string>(CANONICAL_EVENT_TYPES);

/**
 * True when the event's `type` is one of the canonical strings AND its
 * payload satisfies the canonical shape. Returns `false` for tampered
 * payloads (e.g. `memory.added` without a string `content`) so callers
 * can fall back to the open-envelope branch instead of trusting an
 * ill-formed event.
 *
 * Performs **structural** checks only — no deep clone, no mutation.
 */
export function isCanonicalRunEvent(event: RunEvent): event is CanonicalRunEvent {
  if (!CANONICAL_TYPE_SET.has(event.type)) return false;
  switch (event.type) {
    case "memory.added": {
      const e = event as Record<string, unknown>;
      if (typeof e.content !== "string") return false;
      // Optional scope: when present must be "actor" | "shared".
      if (e.scope !== undefined && e.scope !== "actor" && e.scope !== "shared") return false;
      return true;
    }
    case "pinned.set": {
      const e = event as Record<string, unknown>;
      if (typeof e.key !== "string" || e.key.length === 0) return false;
      if (!("content" in e)) return false;
      if (e.scope !== undefined && e.scope !== "actor" && e.scope !== "shared") return false;
      return true;
    }
    case "output.emitted":
      return "data" in event;
    case "log.written": {
      const e = event as Record<string, unknown>;
      return (
        (e.level === "info" || e.level === "warn" || e.level === "error") &&
        typeof e.message === "string"
      );
    }
    case "report.appended":
      return typeof (event as Record<string, unknown>).content === "string";
    case "appstrate.progress":
    case "appstrate.error":
      return typeof (event as Record<string, unknown>).message === "string";
    case "appstrate.metric": {
      const e = event as Record<string, unknown>;
      // usage and cost are both optional, but when present must be valid:
      // usage = plain object, cost = non-negative finite number.
      if (e.usage !== undefined) {
        if (e.usage === null || typeof e.usage !== "object" || Array.isArray(e.usage)) return false;
      }
      if (e.cost !== undefined) {
        if (typeof e.cost !== "number" || !Number.isFinite(e.cost) || e.cost < 0) return false;
      }
      return true;
    }
    case "run.started":
      // No required payload — proof-of-life envelope alone is enough.
      return true;
    case "run.success":
    case "run.timeout":
    case "run.cancelled":
      return true;
    case "run.failed": {
      const e = event as Record<string, unknown>;
      if (e.error === undefined) return true;
      if (e.error === null || typeof e.error !== "object" || Array.isArray(e.error)) return false;
      const err = e.error as Record<string, unknown>;
      if (typeof err.message !== "string") return false;
      // Optional structured fields — when present, MUST be the documented type.
      // Tampered payloads (e.g. `code: 42`) get rejected so callers can fall
      // back to the open-envelope branch instead of trusting an ill-formed event.
      if (err.code !== undefined && typeof err.code !== "string") return false;
      if (err.stack !== undefined && typeof err.stack !== "string") return false;
      if (err.timestamp !== undefined && typeof err.timestamp !== "string") return false;
      if (err.context !== undefined) {
        if (err.context === null || typeof err.context !== "object" || Array.isArray(err.context)) {
          return false;
        }
      }
      return true;
    }
    default:
      return false;
  }
}

/**
 * Narrow an open `RunEvent` to the discriminated union, or `null` if
 * the event is third-party / unknown. Sinks should fold the canonical
 * branch via an exhaustive switch, then forward the original event to
 * downstream consumers regardless of canonicity (so third-party events
 * still flow through the pipeline).
 */
export function narrowCanonicalEvent(event: RunEvent): CanonicalRunEvent | null {
  return isCanonicalRunEvent(event) ? event : null;
}

/**
 * Compile-time exhaustiveness guard. Pass the discriminant value at the
 * `default` branch of a `switch (event.type)`; if a new variant is added
 * to {@link CanonicalRunEvent} without updating the switch, the assignment
 * fails to compile.
 *
 * Usage:
 *   default: { const _x: never = event; void _x; return; }
 */
export function assertExhaustive(value: never): never {
  throw new Error(`Unhandled canonical event type: ${JSON.stringify(value)}`);
}
