// SPDX-License-Identifier: Apache-2.0

/**
 * Disconnect-proof persistence + live resume for one chat turn, extracted from
 * the route so the guarantees are unit-testable.
 *
 * The engine's UI-message stream (a Response body) is teed:
 *  - one branch feeds the resumable producer via `context.run(streamId)` AND the
 *    client, as two sub-branches of a second tee. Recording is driven by the
 *    producer independently of the client, so a reloaded client can reconnect to
 *    the still-live tail (`GET /sessions/:id/stream`).
 *  - the other branch is drained server-side to extract and persist the assistant
 *    turn. This drain runs in an independent task (not tied to the Response), so
 *    it keeps pulling — driving generation to completion — even if the client
 *    disconnects. A closed tab can therefore neither drop the message nor kill
 *    the run. The task is registered in the in-flight registry so graceful
 *    shutdown can await it.
 *
 * The connected client is served its OWN branch, never the store read-back.
 * `context.run()` returns a store reader unconditionally — including to the
 * producer — so handing that reader to the client would make every nominal chat
 * turn round-trip through the store, and (on Redis) poll `XRANGE` for the whole
 * turn just to read back bytes this process already holds. The store read path
 * is for RESUME only: a second tab, or a reconnect after a disconnect, both of
 * which go through `context.resume()` in `routes.ts`.
 *
 * Data-safety does NOT depend on the resumable store: persistence is the drain
 * branch. Resume is the live-token-reconnect polish on top.
 */

import type { UIMessage } from "ai";
import type { ResumableStreamContext } from "assistant-stream/resumable";
import { logger } from "./logger.ts";
import { extractAssistantMessage } from "./stream-parse.ts";
import { trackTurn } from "./inflight.ts";
import { getResumableContext, releaseRecording } from "./resumable.ts";

/**
 * How the RECORD branch batches bytes before handing them to the store.
 *
 * The resumable producer issues one store `append` per chunk it reads, and on
 * Redis an append is one `GET meta` plus one `XADD` + 2×`EXPIRE` pipeline
 * (`assistant-stream` `ResumableStreamContext.js` / `stores/redis-impl.js`).
 * Unbatched, that is two Redis round trips per SSE chunk — i.e. per model token
 * — per concurrent turn, and the tee queue feeding the producer grows for as
 * long as Redis lags behind the token rate. Batching on a short window bounds
 * the append rate at `1000 / flushIntervalMs` per turn regardless of token rate,
 * at the cost of a resumed reader seeing the tail up to one window late.
 *
 * Only the record branch is batched. The CLIENT branch is untouched — every
 * chunk is forwarded the instant the engine emits it.
 */
interface RecordingCoalesceOptions {
  /** Flush at most this long after the first byte buffered. Default 50 ms. */
  flushIntervalMs?: number;
  /** Flush as soon as this many bytes are buffered. Default 16 KiB. */
  flushBytes?: number;
}

const DEFAULT_RECORD_FLUSH_INTERVAL_MS = 50;
const DEFAULT_RECORD_FLUSH_BYTES = 16 * 1024;

/**
 * Byte-level coalescer for the record branch: concatenates `Uint8Array` chunks
 * and emits one chunk per window / size threshold, plus whatever is left at
 * stream end. It is safe to cut anywhere: SSE is a byte stream, and both replay
 * readers reassemble frames across chunk boundaries — the server-side parser
 * (`@appstrate/core/sse` `parseSseFrames` carries the unterminated tail over in
 * `buffer`) and the AI SDK client (`parseJsonEventStream` pipes through
 * `eventsource-parser`'s incremental `EventSourceParserStream`).
 */
function coalesceRecording(
  options: RecordingCoalesceOptions = {},
): TransformStream<Uint8Array, Uint8Array> {
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_RECORD_FLUSH_INTERVAL_MS;
  const flushBytes = options.flushBytes ?? DEFAULT_RECORD_FLUSH_BYTES;

  let buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const drain = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (bufferedBytes === 0) return;
    const out = new Uint8Array(bufferedBytes);
    let offset = 0;
    for (const part of buffered) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    buffered = [];
    bufferedBytes = 0;
    controller.enqueue(out);
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffered.push(chunk);
      bufferedBytes += chunk.byteLength;
      if (bufferedBytes >= flushBytes) {
        drain(controller);
        return;
      }
      if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined;
          // The stream may have been cancelled (producer task failed and
          // cancelled its reader) between arming and firing; `enqueue` then
          // throws on the closed controller. Nothing to do with the bytes.
          try {
            drain(controller);
          } catch {
            buffered = [];
            bufferedBytes = 0;
          }
        }, flushIntervalMs);
      }
    },
    flush(controller) {
      drain(controller);
    },
  });
}

interface FinalizeChatStreamOptions {
  /** The engine's UI-message-stream Response. */
  engineResponse: Response;
  /** Resumable producer key — the id stored as `chat_sessions.active_stream_id`. */
  streamId: string;
  /**
   * Persist the turn's assistant message, following
   * {@link precedingMessageId}. Called at most once — a turn carries exactly
   * one assistant message (see `stream-parse.ts`). Omit when there is no
   * session to persist into (the stream is still drained so the source
   * completes). Runs to completion independently of the client connection.
   */
  onAssistant?: (message: UIMessage, precedingMessageId: string | null) => unknown;
  /** The message the assistant turn follows — the user turn's message id. */
  precedingMessageId?: string | null;
  /** Best-effort teardown after persistence settles (close MCP, unregister stop, clear active stream). */
  onSettled?: () => void;
  /** Injection seam for tests — defaults to the process-wide resumable context. */
  resumableContext?: ResumableStreamContext;
  /** Record-branch batching knobs — tests only; production takes the defaults. */
  recording?: RecordingCoalesceOptions;
  /**
   * Grace before the recording is deleted from the store once the turn is over
   * — tests only, see `releaseRecording` for the production default and why it
   * is not zero.
   */
  recordingGraceMs?: number;
}

export async function finalizeChatStream(opts: FinalizeChatStreamOptions): Promise<Response> {
  const { engineResponse, streamId, onAssistant, precedingMessageId, onSettled } = opts;
  const context = opts.resumableContext ?? getResumableContext();

  const sourceBody = engineResponse.body;
  if (!sourceBody) {
    onSettled?.();
    return engineResponse;
  }

  const [forRecord, forPersist] = sourceBody.tee();

  // Resolved once `context.run()` has settled (either way), so the release
  // scheduled below can never run ahead of the acquire it is meant to undo.
  let recordingSettled!: () => void;
  const recordingStarted = new Promise<void>((resolve) => {
    recordingSettled = resolve;
  });

  // Persist the assistant turn when the stream finalizes. Started BEFORE the
  // Response is returned and not tied to it, so a client disconnect cannot skip
  // it. Reading the whole branch also drives generation to completion.
  const persistTask = (async () => {
    try {
      if (!onAssistant) {
        await forPersist.pipeTo(new WritableStream());
        return;
      }
      // Consume the stream ONCE, up front: parse before persisting so a persist
      // failure can be retried without re-reading the (now drained) branch.
      const assistant = await extractAssistantMessage(forPersist);
      if (!assistant) return;
      const persist = () => onAssistant(assistant, precedingMessageId ?? null);
      try {
        await persist();
      } catch (firstErr) {
        // Retry once after a short delay: a transient DB hiccup should not silently
        // lose the assistant turn. The upsert is keyed by (session, message id), so
        // re-running an already-persisted message is idempotent.
        await new Promise((r) => setTimeout(r, 250));
        try {
          await persist();
        } catch {
          throw firstErr;
        }
      }
    } catch (err) {
      // The persist drain is the data-safety guarantee — a failure here silently
      // loses the assistant turn, so it must be traceable, not swallowed.
      logger.error("chat assistant persist failed", { err: String(err) });
      // Best-effort: release the branch so the tee buffer is not retained.
      await forPersist.cancel().catch(() => {});
    } finally {
      onSettled?.();
      // The turn is over: nothing will resume it once `onSettled` has cleared
      // the session's marker. Drop the recording after a grace rather than let
      // it sit in the store until the TTL backstop.
      await recordingStarted;
      releaseRecording(streamId, {
        context,
        ...(opts.recordingGraceMs !== undefined ? { graceMs: opts.recordingGraceMs } : {}),
      });
    }
  })();
  trackTurn(persistTask);

  // Split the recording branch once more: `forStore` feeds the resumable
  // producer, `forClient` IS the response body. The connected client therefore
  // reads the engine bytes directly — no store round-trip, no poll loop — while
  // the producer keeps recording regardless of whether the client is still
  // there, which is what makes a mid-turn reload resumable.
  const [forStore, forClient] = forRecord.tee();
  // Batch the record branch only (see `coalesceRecording`): the client branch
  // stays chunk-for-chunk with the engine.
  const forStoreBatched = forStore.pipeThrough(coalesceRecording(opts.recording));
  try {
    // `run()` hands back a store reader even to the producer. We already have the
    // bytes, so cancel it immediately: left unread it would poll the store for the
    // whole turn. Resume readers get their own via `context.resume()`.
    const unusedStoreReader = await context.run(streamId, () => forStoreBatched);
    void unusedStoreReader.cancel().catch(() => {});
  } catch (err) {
    // Resume unavailable this turn; client still streams + persistence still runs.
    // Release the unread producer branch so the tee stops buffering it.
    void err;
    void forStoreBatched.cancel().catch(() => {});
  } finally {
    recordingSettled();
  }

  return new Response(forClient, {
    status: engineResponse.status,
    statusText: engineResponse.statusText,
    headers: engineResponse.headers,
  });
}
