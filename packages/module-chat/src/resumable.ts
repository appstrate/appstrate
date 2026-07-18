// SPDX-License-Identifier: Apache-2.0

/**
 * Resumable-stream plumbing for live mid-inference reconnect.
 *
 * A chat turn's UI-message SSE bytes are recorded into a resumable store while
 * they stream to the client. If the page reloads mid-turn, the client's native
 * AI-SDK reconnect (`useChat({ resume: true })`) hits `GET /sessions/:id/stream`,
 * which replays the recorded bytes + the still-live tail — so tokens continue
 * exactly where they were, ChatGPT-style.
 *
 * Store tiering follows progressive-infra: Redis when `REDIS_URL` is set (resume
 * survives across replicas), else an in-process map (single-replica resume —
 * same constraint as `stop-registry.ts`). The store is NOT what guarantees
 * data-safety: the assistant turn is persisted by `finalize-stream.ts`'s
 * independent drain regardless of the store, so even with no resume the reload
 * loads the completed turn from the DB.
 *
 * The chat-id → in-flight-stream-id mapping lives on `chat_sessions.active_stream_id`
 * (set when a turn starts, cleared when it finalizes). The resume endpoint reads
 * it to find which stream to replay; a stale id with no live producer in the
 * store resolves to "no active stream".
 */

import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { chatSessions } from "@appstrate/db/schema";
import { notifySessionUpdate } from "./realtime.ts";
import {
  createResumableStreamContext,
  createInMemoryResumableStreamStore,
  type ResumableStreamContext,
  type ResumableStreamStore,
} from "assistant-stream/resumable";
import { createIoredisResumableStreamStore } from "assistant-stream/resumable/ioredis";
import { logger } from "./logger.ts";

let context: ResumableStreamContext | null = null;

/** Build the store once: Redis if reachable, else in-memory (single replica). */
function buildStore(): ResumableStreamStore {
  const url = process.env.REDIS_URL;
  if (url) {
    try {
      // Lazy require so a missing/broken ioredis never blocks chat — resume
      // simply degrades to single-replica in-memory.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Redis = require("ioredis") as typeof import("ioredis").default;
      const client = new Redis(url, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        connectTimeout: 10_000,
        retryStrategy: (times: number) => Math.min(times * 200, 5_000),
      });
      client.on("error", (err: Error) =>
        logger.warn("chat resumable redis error", { error: err.message }),
      );
      logger.info("chat resumable store: redis");
      return createIoredisResumableStreamStore(client);
    } catch (err) {
      logger.warn("chat resumable: ioredis unavailable, using in-memory store", {
        err: String(err),
      });
    }
  }
  logger.info("chat resumable store: in-memory (single replica)");
  return createInMemoryResumableStreamStore();
}

/** Lazily-created singleton resumable-stream context. */
export function getResumableContext(): ResumableStreamContext {
  if (!context) context = createResumableStreamContext({ store: buildStore() });
  return context;
}

/**
 * Mark a session's in-flight stream so a reloaded client can reconnect to it.
 * Signals the change (`generating` flipped true) so connected clients update
 * the spinner without polling.
 */
export async function setActiveStream(sessionId: string, streamId: string): Promise<void> {
  const [row] = await db
    .update(chatSessions)
    .set({ activeStreamId: streamId })
    .where(eq(chatSessions.id, sessionId))
    .returning({ orgId: chatSessions.orgId, userId: chatSessions.userId });
  if (row) await notifySessionUpdate(sessionId, row.orgId, row.userId);
}

/**
 * Clear the in-flight marker once a turn finalizes (or fails) — but ONLY when
 * it still points at THIS turn's stream. If a concurrent (newer) turn on the
 * same session has already overwritten `active_stream_id` with its own id via
 * `setActiveStream`, an unconditional clear would wipe the newer turn's marker
 * and leave its still-live stream unreconnectable (a reloaded client's resume
 * GET would 204). The `activeStreamId = streamId` guard makes the clear a no-op
 * in that race.
 */
export async function clearActiveStream(sessionId: string, streamId: string): Promise<void> {
  const [row] = await db
    .update(chatSessions)
    .set({ activeStreamId: null })
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.activeStreamId, streamId)))
    .returning({ orgId: chatSessions.orgId, userId: chatSessions.userId });
  // No-op race (a newer turn already owns the marker) → no row, no signal.
  if (row) await notifySessionUpdate(sessionId, row.orgId, row.userId);
}
