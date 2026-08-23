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
 * ## No `dataschema`
 *
 * Envelopes used to carry the OPTIONAL CloudEvents `dataschema` attribute
 * (§3.1) for the seven canonical types, pointing at
 * `https://schemas.afps.dev/v0/events/*` and
 * `https://schemas.appstrate.dev/v0/events/*`. Both claims were withdrawn:
 *
 *  - Nothing was ever served at either host — the first 404s, the second has
 *    no DNS record at all.
 *  - More importantly, the AFPS `RunEvent` payload is deliberately an OPEN
 *    index signature (`@afps-spec/types`): the specification reserves event
 *    *namespaces*, never payload *shapes*, precisely so tools can carry what
 *    they need "without amending the spec". Minting payload schemas under
 *    `schemas.afps.dev` asserted a normative shape the specification has not
 *    adopted, decided in this repository rather than through the AFPS change
 *    process (`afps-spec/GOVERNANCE.md`).
 *
 * If AFPS ever does standardize event payloads, that is a spec change first —
 * §events in `spec.md`, documents under `packages/schema/v0/events/`, a Pages
 * job that copies them — and only then a `dataschema` attribute here.
 *
 * Receivers still accept the attribute on the wire, because runtime images
 * built before this change keep sending it.
 */

import type { RunEvent } from "@afps-spec/types";

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
