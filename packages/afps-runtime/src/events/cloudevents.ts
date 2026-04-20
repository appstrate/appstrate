// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * CloudEvents 1.0 envelope construction for AFPS events.
 *
 * Every AFPS event posted to an `HttpSink` is wrapped in a CloudEvents
 * 1.0 envelope so it is interoperable with Knative, Argo, observability
 * tooling, and the wider eventing ecosystem.
 *
 * Specification: see `AFPS_EXTENSION_ARCHITECTURE.md` §5.
 */

import type { AfpsEvent } from "../types/afps-event.ts";

export interface CloudEventEnvelope {
  specversion: "1.0";
  type: CloudEventType;
  source: string;
  id: string;
  time: string; // RFC 3339
  datacontenttype: "application/json";
  data: unknown;
  /**
   * Non-standard extension attribute documenting the per-run sequence
   * index. Lets receivers verify ordering without reaching into the
   * payload.
   */
  sequence: number;
}

export type CloudEventType =
  | "dev.afps.add_memory.v1"
  | "dev.afps.set_state.v1"
  | "dev.afps.output.v1"
  | "dev.afps.report.v1"
  | "dev.afps.log.v1";

const EVENT_TYPE_MAP: Record<AfpsEvent["type"], CloudEventType> = {
  add_memory: "dev.afps.add_memory.v1",
  set_state: "dev.afps.set_state.v1",
  output: "dev.afps.output.v1",
  report: "dev.afps.report.v1",
  log: "dev.afps.log.v1",
};

export interface BuildEnvelopeOptions {
  event: AfpsEvent;
  runId: string;
  sequence: number;
  /** Message id (typically a UUIDv7). */
  id: string;
  /** Reference time (Unix ms). Defaults to `Date.now()`. */
  nowMs?: number;
}

export function buildCloudEventEnvelope(opts: BuildEnvelopeOptions): CloudEventEnvelope {
  const { event, runId, sequence, id } = opts;
  const nowMs = opts.nowMs ?? Date.now();

  return {
    specversion: "1.0",
    type: EVENT_TYPE_MAP[event.type],
    source: `/afps/runs/${runId}`,
    id,
    time: new Date(nowMs).toISOString(),
    datacontenttype: "application/json",
    data: dataFor(event),
    sequence,
  };
}

function dataFor(event: AfpsEvent): unknown {
  // Strip the `type` discriminator — it lives on the envelope now.
  switch (event.type) {
    case "add_memory":
      return { content: event.content };
    case "set_state":
      return { state: event.state };
    case "output":
      return { data: event.data };
    case "report":
      return { content: event.content };
    case "log":
      return { level: event.level, message: event.message };
  }
}
