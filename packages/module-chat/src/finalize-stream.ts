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
 * turn round-trip through the store, and (on Redis) poll `XRANGE` every 100ms
 * for the whole turn just to read back bytes this process already holds. The
 * store read path is for RESUME only: a second tab, or a reconnect after a
 * disconnect, both of which go through `context.resume()` in `routes.ts`.
 *
 * Data-safety does NOT depend on the resumable store: persistence is the drain
 * branch. Resume is the live-token-reconnect polish on top.
 */

import type { UIMessage } from "ai";
import type { ResumableStreamContext } from "assistant-stream/resumable";
import { logger } from "./logger.ts";
import { extractAssistantMessage } from "./stream-parse.ts";
import { trackTurn } from "./inflight.ts";
import { getResumableContext } from "./resumable.ts";

interface FinalizeChatStreamOptions {
  /** The engine's UI-message-stream Response. */
  engineResponse: Response;
  /** Resumable producer key — the id stored as `chat_sessions.active_stream_id`. */
  streamId: string;
  /**
   * Persist the turn's assistant message, chained onto {@link parentId}. Called
   * at most once — a turn carries exactly one assistant message (see
   * `stream-parse.ts`). Omit when there is no session to persist into (the
   * stream is still drained so the source completes). Runs to completion
   * independently of the client connection.
   */
  onAssistant?: (message: UIMessage, parentId: string | null) => unknown;
  /** Parent for the assistant message — the user turn's message id. */
  parentId?: string | null;
  /** Best-effort teardown after persistence settles (close MCP, unregister stop, clear active stream). */
  onSettled?: () => void;
  /** Injection seam for tests — defaults to the process-wide resumable context. */
  resumableContext?: ResumableStreamContext;
}

export async function finalizeChatStream(opts: FinalizeChatStreamOptions): Promise<Response> {
  const { engineResponse, streamId, onAssistant, parentId, onSettled } = opts;

  const sourceBody = engineResponse.body;
  if (!sourceBody) {
    onSettled?.();
    return engineResponse;
  }

  const [forRecord, forPersist] = sourceBody.tee();

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
      const persist = () => onAssistant(assistant, parentId ?? null);
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
    }
  })();
  trackTurn(persistTask);

  // Split the recording branch once more: `forStore` feeds the resumable
  // producer, `forClient` IS the response body. The connected client therefore
  // reads the engine bytes directly — no store round-trip, no poll loop — while
  // the producer keeps recording regardless of whether the client is still
  // there, which is what makes a mid-turn reload resumable.
  const [forStore, forClient] = forRecord.tee();
  try {
    // `run()` hands back a store reader even to the producer. We already have the
    // bytes, so cancel it immediately: left unread it would poll the store for the
    // whole turn. Resume readers get their own via `context.resume()`.
    const unusedStoreReader = await (opts.resumableContext ?? getResumableContext()).run(
      streamId,
      () => forStore,
    );
    void unusedStoreReader.cancel().catch(() => {});
  } catch (err) {
    // Resume unavailable this turn; client still streams + persistence still runs.
    // Release the unread producer branch so the tee stops buffering it.
    void err;
    void forStore.cancel().catch(() => {});
  }

  return new Response(forClient, {
    status: engineResponse.status,
    statusText: engineResponse.statusText,
    headers: engineResponse.headers,
  });
}
