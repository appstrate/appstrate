// SPDX-License-Identifier: Apache-2.0

/**
 * SSE (Server-Sent Events) stream parsing helpers for integration tests.
 *
 * Parses ReadableStream<Uint8Array> into structured SSE events
 * following the EventSource spec: fields separated by \n\n blocks.
 */

import type { RealtimeEvent } from "@appstrate/shared-types";

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

export interface SSEEvent {
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
 * Async generator that parses an SSE ReadableStream into structured events.
 *
 * Reads chunks from the stream, splits by double-newline delimiters,
 * and extracts `event:` and `data:` fields from each SSE frame.
 */
export async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Split on double newline (SSE frame delimiter)
      const frames = buffer.split("\n\n");
      // Keep the last incomplete frame in the buffer
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

        if (event) {
          yield { event, data, ...(id !== undefined ? { id } : {}) };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
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
