// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * AFPS 1.3 — open RunEvent envelope.
 *
 * The envelope (`type`, `timestamp`, `runId`) is stable so any EventSink
 * can route events without understanding the payload. The payload itself
 * is an open index signature so third-party tool packages can emit their
 * own events without amending the runtime or the spec.
 *
 * Reserved core domains: `memory`, `state`, `output`, `report`, `log`,
 * `provider`. Third-party tools SHOULD namespace their own types
 * (e.g. `"@my-org/audit.logged"`).
 *
 * Specification: `afps-spec/schema/src/interfaces.ts` — {@link RunEvent}.
 */

import type { AfpsEvent } from "./afps-event.ts";

/**
 * Open envelope emitted by tools during a run. Re-exported from
 * `@afps-spec/schema/interfaces` for type parity, but redeclared here so
 * the runtime has no type-level dependency edge on the spec package for
 * this shape (the spec only formalises the contract; the runtime owns
 * the runtime-level behaviour).
 */
export interface RunEvent {
  /** "<domain>.<verb>" — discriminant chosen by the emitting tool. */
  type: string;
  /** Unix milliseconds at emission time. */
  timestamp: number;
  /** The run's stable identifier. */
  runId: string;
  /** LLM tool-call id, when the event originates from a tool call. */
  toolCallId?: string;
  /** Payload — tool-defined, open schema. */
  [key: string]: unknown;
}

// ─────────────────────────────────────────────
// Legacy ↔ open adapter
// ─────────────────────────────────────────────

/**
 * Open-envelope `type` values emitted for the five legacy platform tools.
 *
 * Kept in sync with the reserved core domains of {@link RunEvent}. The
 * `dev.afps.*` CloudEvents type emitted by `HttpSink` is unchanged — it
 * is a transport-level concern, not the event-identity concern.
 */
export const LEGACY_RUN_EVENT_TYPES = {
  add_memory: "memory.added",
  set_state: "state.set",
  output: "output.emitted",
  report: "report.appended",
  log: "log.written",
} as const satisfies Record<AfpsEvent["type"], string>;

/** Reverse map — open `type` → legacy discriminant. */
export const LEGACY_DISCRIMINANT_FROM_RUN_TYPE: Record<string, AfpsEvent["type"] | undefined> = {
  "memory.added": "add_memory",
  "state.set": "set_state",
  "output.emitted": "output",
  "report.appended": "report",
  "log.written": "log",
};

export interface ToRunEventOptions {
  event: AfpsEvent;
  runId: string;
  /** LLM tool-call id, when the event originates from a tool call. */
  toolCallId?: string;
  /** Reference time (Unix ms). Defaults to `Date.now()`. */
  nowMs?: number;
}

/**
 * Lift a legacy `AfpsEvent` into an open `RunEvent` with a canonical
 * core-domain `type`. The original payload is spread onto the envelope
 * so consumers keep access to `content` / `state` / `data` / `level` /
 * `message` without reaching into a nested field.
 */
export function toRunEvent(opts: ToRunEventOptions): RunEvent {
  const { event, runId, toolCallId } = opts;
  const timestamp = opts.nowMs ?? Date.now();
  const base: RunEvent = {
    type: LEGACY_RUN_EVENT_TYPES[event.type],
    timestamp,
    runId,
    ...(toolCallId !== undefined ? { toolCallId } : {}),
  };

  switch (event.type) {
    case "add_memory":
      return { ...base, content: event.content };
    case "set_state":
      return { ...base, state: event.state };
    case "output":
      return { ...base, data: event.data };
    case "report":
      return { ...base, content: event.content };
    case "log":
      return { ...base, level: event.level, message: event.message };
  }
}

/**
 * Inverse of {@link toRunEvent}: best-effort projection of an open
 * {@link RunEvent} back into a legacy {@link AfpsEvent}. Returns `null`
 * for open `type` values that do not map to one of the five reserved
 * core domains — the event is a third-party event and has no legacy
 * representation.
 */
export function fromRunEvent(event: RunEvent): AfpsEvent | null {
  const discriminant = LEGACY_DISCRIMINANT_FROM_RUN_TYPE[event.type];
  if (!discriminant) return null;

  switch (discriminant) {
    case "add_memory":
      return typeof event.content === "string"
        ? { type: "add_memory", content: event.content }
        : null;
    case "set_state":
      return { type: "set_state", state: event.state };
    case "output":
      return { type: "output", data: event.data };
    case "report":
      return typeof event.content === "string" ? { type: "report", content: event.content } : null;
    case "log": {
      if (typeof event.message !== "string") return null;
      const level = event.level;
      if (level !== "info" && level !== "warn" && level !== "error") return null;
      return { type: "log", level, message: event.message };
    }
  }
}
