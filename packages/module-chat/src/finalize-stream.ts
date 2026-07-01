// SPDX-License-Identifier: Apache-2.0

/**
 * Disconnect-proof persistence + live resume for one chat turn — shared by both
 * engines and extracted here so the guarantees are unit-testable.
 *
 * The engine's UI-message stream (a Response body) is teed:
 *  - one branch is recorded into the resumable store via `context.run(streamId)`,
 *    whose returned consumer is what we hand to the client. Recording is driven
 *    by the producer independently of the client consumer, so a reloaded client
 *    can reconnect to the still-live tail (`GET /sessions/:id/stream`).
 *  - the other branch is drained server-side to extract and persist the assistant
 *    turn. This drain runs in an independent task (not tied to the Response), so
 *    it keeps pulling — driving generation to completion — even if the client
 *    disconnects. A closed tab can therefore neither drop the message nor kill
 *    the run. The task is registered in the in-flight registry so graceful
 *    shutdown can await it.
 *
 * Data-safety does NOT depend on the resumable store: persistence is the drain
 * branch. Resume is the live-token-reconnect polish on top.
 */

import type { UIMessage } from "ai";
import { logger } from "./logger.ts";
import { extractAssistantMessages } from "./stream-parse.ts";
import { trackTurn } from "./inflight.ts";
import { getResumableContext } from "./resumable.ts";

export interface FinalizeChatStreamOptions {
  /** The engine's UI-message-stream Response (ai-sdk or subscription engine). */
  engineResponse: Response;
  /** Resumable producer key — the id stored as `chat_sessions.active_stream_id`. */
  streamId: string;
  /**
   * Persist ONE assistant message, chained onto `parentId`, and return the id it
   * was stored under. Called once per assistant message the turn emits, in order,
   * with each call's `parentId` set to the previous call's return value (the first
   * chains onto {@link parentId}). Omit when there is no session to persist into
   * (the stream is still drained so the source completes). Runs to completion
   * independently of the client connection.
   */
  onAssistant?: (message: UIMessage, parentId: string | null) => Promise<string> | string;
  /** Parent for the first assistant message — the user turn's message id. */
  parentId?: string | null;
  /** Best-effort teardown after persistence settles (close MCP, unregister stop, clear active stream). */
  onSettled?: () => void;
}

export async function finalizeChatStream(opts: FinalizeChatStreamOptions): Promise<Response> {
  const { engineResponse, streamId, onAssistant, parentId, onSettled } = opts;

  const sourceBody = engineResponse.body;
  if (!sourceBody) {
    onSettled?.();
    return engineResponse;
  }

  const [forStore, forPersist] = sourceBody.tee();

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
      // failure can be retried without re-reading the (now drained) branch. A turn
      // may emit several assistant messages — persist each in order, chaining each
      // onto the previous (the first onto the user turn's `parentId`).
      const assistants = (await extractAssistantMessages(forPersist)).filter(
        (m) => m.role === "assistant",
      );
      const persistAll = async () => {
        let parent = parentId ?? null;
        for (const assistant of assistants) {
          parent = await onAssistant(assistant, parent);
        }
      };
      try {
        await persistAll();
      } catch (firstErr) {
        // Retry once after a short delay: a transient DB hiccup should not silently
        // lose the assistant turn. Upserts are keyed by (session, message id), so
        // re-running any already-persisted messages is idempotent.
        await new Promise((r) => setTimeout(r, 250));
        try {
          await persistAll();
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

  // Record the turn's bytes for resume; the returned consumer is the client view.
  // The producer reads `forStore` into the store regardless of this consumer, so
  // a client disconnect does not stop recording. If the resumable layer fails for
  // any reason, fall back to the raw client branch — never break the live turn.
  let clientStream: ReadableStream<Uint8Array> = forStore;
  try {
    clientStream = await getResumableContext().run(streamId, () => forStore);
  } catch (err) {
    // Resume unavailable this turn; client still streams + persistence still runs.
    void err;
  }

  return new Response(clientStream, {
    status: engineResponse.status,
    statusText: engineResponse.statusText,
    headers: engineResponse.headers,
  });
}
