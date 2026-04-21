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
 * Specification: `afps-spec/spec.md` — {@link RunEvent}.
 */

/**
 * Open envelope emitted by tools during a run. Mirrors the shape exported
 * by `@afps/types` (the vendor-neutral TS projection of the AFPS spec);
 * redeclared here so the runtime has no type-level dependency edge on
 * the types package for this shape.
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
