// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * CloudEvents 1.0 envelope construction for AFPS RunEvents.
 *
 * Every {@link RunEvent} posted to an `HttpSink` is wrapped in a
 * CloudEvents 1.0 envelope so it is interoperable with Knative, Argo,
 * observability tooling, and the wider eventing ecosystem. The CloudEvent
 * `type` mirrors the RunEvent `type` verbatim — e.g. `memory.added`,
 * `state.set`, or any third-party `@scope/tool.verb`.
 *
 * Specification: see AFPS spec §8 and CloudEvents 1.0.
 */

import type { RunEvent } from "@afps/types";

export interface CloudEventEnvelope {
  specversion: "1.0";
  /** Verbatim RunEvent.type — e.g. `memory.added`, `@my-org/audit.logged`. */
  type: string;
  source: string;
  id: string;
  time: string; // RFC 3339
  datacontenttype: "application/json";
  data: Record<string, unknown>;
  /**
   * Non-standard CloudEvents extension attribute
   * (https://github.com/cloudevents/spec/blob/main/cloudevents/extensions/sequence.md)
   * documenting the per-run sequence index. Assigned by the sink at emit
   * time — lets receivers verify ordering without reaching into the
   * payload or relying on clock precision.
   */
  sequence: number;
}

export interface BuildEnvelopeOptions {
  event: RunEvent;
  sequence: number;
  /** Message id (typically a UUIDv7). */
  id: string;
  /** Reference time (Unix ms). Defaults to `event.timestamp`. */
  nowMs?: number;
}

/** RunEvent envelope fields that are NOT part of the CloudEvent data payload. */
const ENVELOPE_KEYS = new Set<string>(["type", "timestamp", "runId", "toolCallId"]);

export function buildCloudEventEnvelope(opts: BuildEnvelopeOptions): CloudEventEnvelope {
  const { event, sequence, id } = opts;
  const nowMs = opts.nowMs ?? event.timestamp;

  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (!ENVELOPE_KEYS.has(key)) data[key] = value;
  }

  return {
    specversion: "1.0",
    type: event.type,
    source: `/afps/runs/${event.runId}`,
    id,
    time: new Date(nowMs).toISOString(),
    datacontenttype: "application/json",
    data,
    sequence,
  };
}
