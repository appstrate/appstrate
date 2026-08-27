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
 * Store tiering follows progressive-infra: Redis when the platform hands one to
 * `configureResumableStore` at init (resume survives across replicas), else an
 * in-process map (single-replica resume —
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
import Redis from "ioredis";
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
let client: Redis | null = null;
let redisUrl: string | null = null;

/**
 * Retention for a turn's recorded bytes (both stores default to 24h).
 *
 * A day of retention buys nothing: the only window in which anything reads a
 * recording back is "while the turn is live", and `clearActiveStream` drops the
 * pointer to it the moment the turn finalizes — nothing can resume a finished
 * turn. Everything past that point is a day of raw SSE bytes per chat turn held
 * in Redis (or in the in-memory map on the single-replica tier).
 *
 * The TTL is refreshed on every append, so this is an inactivity budget measured
 * from the last chunk, sized off the same 30min ceiling a turn's engine loopback
 * token gets (`chat-stream.ts` ENGINE_LOOPBACK_TTL_MS). A turn silent for longer
 * than that is dead and its bytes are garbage.
 */
const STREAM_TTL_MS = 30 * 60_000;

/**
 * Retries ioredis attempts per command before rejecting.
 *
 * This client sits on a REQUEST path — `GET /api/chat/sessions/:id/stream`
 * reads through it — so it takes the same finite budget as every other
 * request-path client in the platform (`apps/api/src/lib/redis.ts`). `null`
 * ("retry forever", what this store used to pass) means that while Redis is
 * unreachable the resume read HANGS instead of failing, and the request hangs
 * with it. A finite count turns a Redis outage into a fast rejection the route
 * can answer.
 */
const MAX_RETRIES_PER_REQUEST = 3;

/**
 * Redis client for the resumable store, on the platform's request-path
 * contract. Exported so the retry budget is assertable without a live Redis.
 */
export function createResumableRedis(url: string): Redis {
  const redis = new Redis(url, {
    maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST,
    enableReadyCheck: false,
    connectTimeout: 10_000,
    retryStrategy: (times: number) => Math.min(times * 200, 5_000),
  });
  redis.on("error", (err: Error) =>
    logger.warn("chat resumable redis error", { error: err.message }),
  );
  return redis;
}

/** How the store obtains its client. See {@link configureResumableStore}. */
export type ResumableRedisFactory = (url: string) => Redis;

let createClient: ResumableRedisFactory = createResumableRedis;

/**
 * Point the store at the platform's Redis. Called once from `chatModule.init`
 * with `ctx.redisUrl` — the module reads no `process.env` of its own, so the
 * store and the rest of the platform can never disagree about which tier is
 * running. `null` (progressive-infra tier 0) keeps the in-memory store.
 *
 * `factory` exists so a test can hold the client this module opens and observe
 * that shutdown really closed it — the module owns the client's whole lifetime
 * and hands out no reference to it, so without this seam "did it close?" is
 * unobservable and the only assertion left is the weaker "was the singleton
 * replaced?". Production never passes it; `mock.module()` is banned repo-wide
 * (see the root CLAUDE.md), so injection is the way.
 */
export function configureResumableStore(
  url: string | null,
  factory: ResumableRedisFactory = createResumableRedis,
): void {
  // Reconfiguring INVALIDATES what is already built. `getResumableContext()` is
  // lazy, so anything that reads it before `chatModule.init` runs — a resume GET
  // served during boot, a test, an out-of-order module — builds the store from
  // whatever `redisUrl` said at that moment (nothing: the in-memory tier) and
  // memoizes it. Writing only the two settings left that context in place, so
  // the platform's own Redis decision arrived too late to matter and the
  // process stayed on the wrong tier for its whole life, silently.
  //
  // The teardown is not awaited because this function is called from `init` and
  // has nothing to wait for: `closeResumableStore` drops the singleton and the
  // client handle SYNCHRONOUSLY (before its first await), so by the time the
  // two assignments below run there is nothing stale left to read. Only the
  // socket's `quit()` finishes later, and no caller needs to observe it.
  void closeResumableStore().catch(() => {});
  redisUrl = url;
  createClient = factory;
}

/** Build the store once: Redis when configured, else in-memory (single replica). */
function buildStore(): ResumableStreamStore {
  if (redisUrl) {
    client = createClient(redisUrl);
    logger.info("chat resumable store: redis");
    return createIoredisResumableStreamStore(client);
  }
  logger.info("chat resumable store: in-memory (single replica)");
  return createInMemoryResumableStreamStore();
}

/** Lazily-created singleton resumable-stream context. */
export function getResumableContext(): ResumableStreamContext {
  if (!context)
    context = createResumableStreamContext({ store: buildStore(), ttlMs: STREAM_TTL_MS });
  return context;
}

/**
 * Release the store's Redis connection on shutdown and drop the singleton, so
 * a restarted module builds a fresh one. Without this the client (and its
 * reconnect loop) outlived the module that opened it.
 *
 * It also DISARMS the configuration, returning the module to the state it boots
 * in: no url, the real factory. Both halves were leaks. Leaving `redisUrl` set
 * meant a `getResumableContext()` after shutdown opened a brand-new Redis
 * client that nothing would ever close — this function is the only closer and
 * it has already run. Leaving an injected `createClient` in place meant a
 * test's factory survived into whatever ran next in the same `bun test`
 * process, since module state is shared across files. After a close the store
 * is the inert in-memory one until someone configures it again, which is the
 * correct reading of "the module is down".
 */
export async function closeResumableStore(): Promise<void> {
  const open = client;
  context = null;
  client = null;
  redisUrl = null;
  createClient = createResumableRedis;
  if (!open) return;
  // `quit()` drains in-flight commands, and it does NOT need a deadline of its
  // own: ioredis only sends the QUIT command on a client whose connection is
  // `ready`/`connect`, and short-circuits to an immediate teardown otherwise.
  // Measured against an unreachable host with this client's options, from all
  // three reachable states (fresh, mid-reconnect-backoff, after a rejected
  // command): resolves in ≤1 ms, with the socket flipping to `end` just after.
  // The `.catch` is the belt for a reject, not for a hang.
  await open.quit().catch(() => open.disconnect());
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
  if (row) notifySessionUpdate(sessionId, row.orgId, row.userId);
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
  if (row) notifySessionUpdate(sessionId, row.orgId, row.userId);
}
