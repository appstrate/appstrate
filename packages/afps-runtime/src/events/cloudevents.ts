// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * CloudEvents 1.0 envelope construction for AFPS RunEvents.
 *
 * Every {@link RunEvent} posted to an `HttpSink` is wrapped in a
 * CloudEvents 1.0 envelope so it is interoperable with Knative, Argo,
 * observability tooling, and the wider eventing ecosystem. The CloudEvent
 * `type` mirrors the RunEvent `type` verbatim — e.g. `memory.added`,
 * `pinned.set`, or any third-party `@scope/tool.verb`.
 *
 * Canonical events additionally carry `dataschema`, a stable versioned
 * IDENTIFIER for the shape of their `data` payload. No document is served
 * at those URIs and none ever was — see `./canonical-event-schemas.ts`,
 * which documents why, and which is where the URIs live.
 *
 * Specification: CloudEvents 1.0 (`dataschema` is §3.1, OPTIONAL).
 */

import type { RunEvent } from "@afps-spec/types";
import { isCanonicalRunEvent } from "../types/canonical-events.ts";
import { canonicalEventSchemaUri } from "./canonical-event-schemas.ts";

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
   * OPTIONAL CloudEvents 1.0 attribute (§3.1) identifying the JSON
   * Schema `data` adheres to. Present only for canonical events whose
   * payload actually validates — see {@link buildCloudEventEnvelope}.
   */
  dataschema?: string;
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

  // `dataschema` is an assertion about `data`, so it is emitted only when
  // the payload genuinely satisfies the canonical shape. A third-party
  // `@scope/tool.verb` event (unknown payload) and a tampered canonical
  // event (e.g. `memory.added` without a string `content`) both fall
  // through without the attribute rather than pointing at a schema they
  // would fail. Omission is conformant — the attribute is OPTIONAL.
  //
  // `isCanonicalRunEvent` is the sole definition of the canonical payload
  // shape. It additionally rejects non-finite numbers, which `JSON.stringify`
  // would turn into `null` — rejecting more is always safe here, since it only
  // omits an OPTIONAL attribute. Its accept/reject verdicts are pinned by
  // `test/fixtures/canonical-event-corpus.ts`.
  const dataschema = isCanonicalRunEvent(event) ? canonicalEventSchemaUri(event.type) : undefined;

  return {
    specversion: "1.0",
    type: event.type,
    source: `/afps/runs/${event.runId}`,
    id,
    time: new Date(nowMs).toISOString(),
    datacontenttype: "application/json",
    data,
    ...(dataschema === undefined ? {} : { dataschema }),
    sequence,
  };
}
