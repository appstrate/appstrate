// SPDX-License-Identifier: Apache-2.0

/**
 * SSE (Server-Sent Events) stream parsing helpers for integration tests.
 *
 * Parses ReadableStream<Uint8Array> into structured SSE events
 * following the EventSource spec: fields separated by \n\n blocks.
 */

import { sql } from "drizzle-orm";
import type { RealtimeEvent } from "@appstrate/shared-types";
import { db } from "./db.ts";

/**
 * Per-channel required-field defaults for a synthetic `pg_notify` payload.
 *
 * The realtime service validates every NOTIFY payload against the shared Zod
 * schemas (`runUpdateEventSchema` / `runLogEventSchema` / `runMetricEventSchema`
 * in `@appstrate/shared-types`) and SILENTLY DROPS anything incomplete — a
 * fixture missing one required key never reaches a subscriber, and the test
 * that fired it fails as a timeout rather than as a validation error. So the
 * defaults mirror the FULL payload the production triggers/broadcaster emit:
 * every key present, `null` where the column is nullable. A test overrides only
 * the fields it asserts on.
 *
 * This lived as two copies — one in `integration/services/realtime.test.ts`,
 * one in `integration/routes/realtime-sse.test.ts`, the second annotated as a
 * mirror of the first. The route-level copy had lost the whole `run_metric`
 * block, so that channel's SSE framing could not be exercised there at all.
 * One home, so a channel added to the producer is added once.
 */
const NOTIFY_DEFAULTS: Record<string, Record<string, unknown>> = {
  run_update: {
    operation: "UPDATE",
    id: "exec-default",
    package_id: null,
    status: "running",
    user_id: null,
    end_user_id: null,
    org_id: "org-default",
    application_id: "app-default",
    schedule_id: null,
    error: null,
    started_at: null,
    completed_at: null,
    duration: null,
  },
  run_log_insert: {
    id: 1,
    run_id: "exec-default",
    org_id: "org-default",
    application_id: "app-default",
    type: "progress",
    level: "info",
    event: null,
    message: null,
    created_at: "2026-01-01T00:00:00.000Z",
  },
  run_metric: {
    run_id: "exec-default",
    org_id: "org-default",
    application_id: "app-default",
    package_id: "pkg-default",
    token_usage: null,
    cost_so_far: 0,
    cost_pricing_status: null,
  },
};

/**
 * Fire a `pg_notify` on `channel` with `payload` merged over the channel's
 * required-field defaults, so the payload matches the real producer shape.
 */
export async function pgNotify(channel: string, payload: Record<string, unknown>): Promise<void> {
  const full = { ...(NOTIFY_DEFAULTS[channel] ?? {}), ...payload };
  await db.execute(sql`SELECT pg_notify(${channel}, ${JSON.stringify(full)})`);
}

/** Maps each event name to its `data` payload type. */
type EventDataMap = {
  [E in RealtimeEvent["event"]]: Extract<RealtimeEvent, { event: E }>["data"];
};

/**
 * Narrow a captured {@link RealtimeEvent} to a specific event's typed `data`.
 *
 * The realtime `send` payload is a discriminated union, so a test that reads
 * `frame.data.costSoFar` must first prove `frame.event === "run_metric"`. This
 * asserts the event name and returns the narrowed, typed `data`. (The return
 * type indexes a mapped type by `E` rather than `Extract<…>["data"]` directly,
 * which TS collapses to an intersection over a generic discriminant.)
 */
export function eventData<E extends RealtimeEvent["event"]>(
  frame: RealtimeEvent,
  event: E,
): EventDataMap[E] {
  if (frame.event !== event) {
    throw new Error(`expected SSE event "${event}", got "${frame.event}"`);
  }
  return frame.data as EventDataMap[E];
}

interface SSEEvent {
  event: string;
  data: string;
  /**
   * Monotonic event id emitted by the server. Per HTML SSE spec, browsers
   * send the most recent id back as `Last-Event-ID` on automatic reconnect
   * so the server can resume the stream. Optional in the test parser
   * because pre-existing fixtures predate id support.
   */
  id?: string;
}

/**
 * Collect N SSE events from a ReadableStream with a timeout.
 *
 * Returns an array of parsed SSE events. Aborts the stream reader
 * after collecting the requested count or when the timeout expires.
 *
 * @param body - The SSE ReadableStream from a Response
 * @param count - Number of events to collect
 * @param options - Optional configuration
 * @param options.timeoutMs - Maximum time to wait (default: 5000ms)
 * @param options.ignoreEvents - Event names to skip (e.g. ["ping"])
 */
export async function collectSSEEvents(
  body: ReadableStream<Uint8Array>,
  count: number,
  options: { timeoutMs?: number; ignoreEvents?: string[] } = {},
): Promise<SSEEvent[]> {
  const { timeoutMs = 5000, ignoreEvents = [] } = options;
  const events: SSEEvent[] = [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const timeout = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), timeoutMs),
  );

  async function readEvents(): Promise<void> {
    while (events.length < count) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split("\n\n");
      buffer = frames.pop()!;

      for (const frame of frames) {
        if (!frame.trim()) continue;

        let event = "";
        let data = "";
        let id: string | undefined;

        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) {
            event = line.slice("event:".length).trim();
          } else if (line.startsWith("data:")) {
            data = line.slice("data:".length).trim();
          } else if (line.startsWith("id:")) {
            id = line.slice("id:".length).trim();
          }
        }

        if (event && !ignoreEvents.includes(event)) {
          events.push({ event, data, ...(id !== undefined ? { id } : {}) });
          if (events.length >= count) return;
        }
      }
    }
  }

  const result = await Promise.race([readEvents(), timeout]);

  // Cancel the reader to close the stream (triggers onAbort in Hono SSE)
  try {
    await reader.cancel();
  } catch {
    // Ignore cancel errors — stream may already be closed
  }

  if (result === "timeout" && events.length < count) {
    throw new Error(`SSE timeout: collected ${events.length}/${count} events in ${timeoutMs}ms`);
  }

  return events;
}
