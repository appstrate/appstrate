// SPDX-License-Identifier: Apache-2.0

/**
 * Chat API — session CRUD + history READ.
 *
 * Sessions are personal: every query filters by (orgId, userId).
 *
 * Persistence is server-authoritative and has exactly TWO writers, both in
 * `persistence.ts`. `POST /api/chat` is the only one on a request path: it
 * stores the user turn before inference and the assistant turn when the stream
 * finalizes (`finalize-stream.ts`). The second is `persistNotice`, which posts
 * a server-authored message into a session with NO live turn — today only the
 * orphaned-run reconciliation (`run-reconcile.ts`), driven by the
 * `onRunStatusChange` event. The two never overlap: `persistNotice` takes the
 * session row's lock and refuses while `active_stream_id` is set, so a turn
 * owns its conversation from start to finalize. The routes below therefore
 * never accept a message — `GET /api/chat/sessions/:id` returns the stored
 * messages for the client's read-only history adapter, in `seq` order, as
 * `{ id, content }` nodes assistant-ui's `ai-sdk/v6` format adapter decodes.
 *
 * There is no `parent_id` and no `format` on the wire. Both were columns
 * nothing ever read back, dropped by `0054` — see the `chatMessages` table doc.
 *
 * Rate limiting: `services.http.rateLimit` (platform capability), captured into
 * the router's `ChatPlatformDeps` at module init (see index.ts).
 */

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { chatMessages, chatSessions } from "@appstrate/db/schema";
import { enterSpaceContext, requireModulePermission } from "@appstrate/core/permissions";
import { notFound, parseBody } from "@appstrate/core/api-errors";
import { UI_MESSAGE_STREAM_HEADERS } from "ai";
import { handleChatStream, type ChatEnv } from "./chat-stream.ts";
import { stopStream } from "./stop-registry.ts";
import { clearActiveStream, getResumableContext, STALE_MARKER_MIN_AGE_MS } from "./resumable.ts";
import { mintSessionId } from "./session-id.ts";
import { notifySessionUpdate } from "./realtime.ts";
import { logger } from "./logger.ts";
import type { ChatPlatformDeps } from "./platform-services.ts";

/** Page size for the session list — one row past this is fetched to derive `hasMore`. */
const SESSIONS_PAGE_SIZE = 100;

export const createSessionSchema = z.object({
  title: z.string().min(1).max(200).optional(),
});

export const renameSessionSchema = z.object({
  title: z.string().min(1).max(200),
});

type SessionRow = typeof chatSessions.$inferSelect;
type MessageRow = typeof chatMessages.$inferSelect;

function toSessionDto(row: SessionRow) {
  return {
    object: "chat_session" as const,
    id: row.id,
    title: row.title,
    // True while a turn is generating — lets the UI badge an "unread" reply on a
    // conversation the user has left, and detect when it finishes. Never leaks
    // the raw stream id.
    generating: row.activeStreamId != null,
    // Computed server-side from the two message-pointer watermarks so only a
    // boolean crosses the wire — no clock anywhere. Unread = an assistant
    // message landed past the owner's read marker.
    unread:
      row.lastAssistantSeq != null &&
      (row.lastReadSeq == null || row.lastReadSeq < row.lastAssistantSeq),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toMessageDto(row: MessageRow) {
  return {
    id: row.messageId,
    content: row.content,
  };
}

/**
 * The `(org, space, user)` triple every session query filters on. A session
 * belongs to ONE space (RBAC spec §5), so the space is part of ownership, not
 * a display filter: the same user in another space must not see it.
 */
function sessionScope(c: Context<ChatEnv>): { orgId: string; spaceId: string; userId: string } {
  return { orgId: c.get("orgId"), spaceId: c.get("space").id, userId: c.get("user").id };
}

async function findOwnedSession(
  id: string,
  scope: { orgId: string; spaceId: string; userId: string },
): Promise<SessionRow | undefined> {
  const [session] = await db
    .select()
    .from(chatSessions)
    .where(
      and(
        eq(chatSessions.id, id),
        eq(chatSessions.orgId, scope.orgId),
        eq(chatSessions.userId, scope.userId),
        eq(chatSessions.spaceId, scope.spaceId),
      ),
    )
    .limit(1);
  return session;
}

async function getOwnedSession(
  id: string,
  scope: { orgId: string; spaceId: string; userId: string },
): Promise<SessionRow> {
  const session = await findOwnedSession(id, scope);
  if (!session) throw notFound("Chat session not found");
  return session;
}

async function loadMessages(sessionId: string): Promise<MessageRow[]> {
  return db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(asc(chatMessages.seq));
}

// ---------------------------------------------------------------------------
// Router — built once at module init with the platform deps captured from
// `ctx.services` (rate limiter + in-process dispatch + subscription-model resolution).
// ---------------------------------------------------------------------------

export function createChatRouter(deps: ChatPlatformDeps) {
  const router = new Hono<ChatEnv>();

  // `chat` is a SPACE-level resource and `/api/chat` is not one of the core
  // space-scoped prefixes (that list is core-only by design), so this router
  // enters the space itself — otherwise `chat:read` / `chat:write` could never
  // be satisfied, since org permissions carry no space-level string
  // (RBAC spec §4.3). The space is the caller's pinned one, else `X-Space-Id`;
  // a caller that names neither gets a 400 (there is no default-space fallback
  // for a direct caller), and one with no role in the space is refused there.
  router.use("/api/chat/*", async (c, next) => {
    await enterSpaceContext(c);
    return next();
  });

  // Platform per-route limiter (POST /api/chat fans out into metered LLM
  // traffic). The platform always supplies it via deps — no unlimited fallback.
  const rateLimited = (limitPerMinute: number): MiddlewareHandler => deps.rateLimit(limitPerMinute);

  // GET /api/chat/sessions — list the caller's sessions in the current org
  router.get("/api/chat/sessions", requireModulePermission("chat", "read"), async (c) => {
    // Fetch one past the page so `hasMore` reflects reality: previously it was
    // hardcoded `false`, so a caller with more than a page of sessions had no
    // signal that older conversations existed beyond the window.
    const scope = sessionScope(c);
    const rows = await db
      .select()
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.orgId, scope.orgId),
          eq(chatSessions.userId, scope.userId),
          eq(chatSessions.spaceId, scope.spaceId),
        ),
      )
      .orderBy(desc(chatSessions.updatedAt))
      .limit(SESSIONS_PAGE_SIZE + 1);
    const hasMore = rows.length > SESSIONS_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, SESSIONS_PAGE_SIZE) : rows;
    return c.json({ object: "list", data: page.map(toSessionDto), hasMore });
  });

  // POST /api/chat/sessions — start a new conversation
  router.post(
    "/api/chat/sessions",
    rateLimited(30),
    requireModulePermission("chat", "write"),
    async (c) => {
      const data = parseBody(createSessionSchema, await c.req.json().catch(() => ({})));
      const scope = sessionScope(c);
      const [row] = await db
        .insert(chatSessions)
        .values({
          id: mintSessionId(),
          orgId: scope.orgId,
          spaceId: scope.spaceId,
          userId: scope.userId,
          title: data.title ?? null,
        })
        .returning();
      notifySessionUpdate(row!.id, row!.orgId, row!.userId);
      return c.json(toSessionDto(row!), 201);
    },
  );

  // GET /api/chat/sessions/:id — the conversation's messages, in seq order (history load)
  router.get("/api/chat/sessions/:id", requireModulePermission("chat", "read"), async (c) => {
    const session = await getOwnedSession(c.req.param("id"), sessionScope(c));
    const messages = await loadMessages(session.id);
    return c.json({ ...toSessionDto(session), messages: messages.map(toMessageDto) });
  });

  // PATCH /api/chat/sessions/:id — rename
  router.patch("/api/chat/sessions/:id", requireModulePermission("chat", "write"), async (c) => {
    const session = await getOwnedSession(c.req.param("id"), sessionScope(c));
    const { title } = parseBody(renameSessionSchema, await c.req.json().catch(() => null));
    await db
      .update(chatSessions)
      .set({ title, updatedAt: new Date() })
      .where(eq(chatSessions.id, session.id));
    notifySessionUpdate(session.id, session.orgId, session.userId);
    return c.body(null, 204);
  });

  // PUT /api/chat/sessions/:id/read — mark the session read (idempotent).
  // Advances the read marker up to the latest known watermark, monotonically
  // (GREATEST) so a late/replayed call can never regress it — and deliberately
  // NOT `updatedAt`, so opening a conversation never reorders the sidebar.
  // Mirrors PUT /notifications/:id/read. The SSE signal syncs the cleared
  // badge to the owner's other devices instantly.
  router.put(
    "/api/chat/sessions/:id/read",
    rateLimited(120),
    requireModulePermission("chat", "write"),
    async (c) => {
      const session = await getOwnedSession(c.req.param("id"), sessionScope(c));
      await db
        .update(chatSessions)
        .set({
          lastReadSeq: sql`GREATEST(coalesce(${chatSessions.lastReadSeq}, 0), coalesce(${chatSessions.lastAssistantSeq}, 0))`,
        })
        .where(eq(chatSessions.id, session.id));
      notifySessionUpdate(session.id, session.orgId, session.userId);
      return c.body(null, 204);
    },
  );

  // DELETE /api/chat/sessions/:id — delete a session (entries cascade)
  router.delete("/api/chat/sessions/:id", requireModulePermission("chat", "write"), async (c) => {
    const session = await getOwnedSession(c.req.param("id"), sessionScope(c));
    // Detach-or-delete the session's files BEFORE the session row is removed:
    // a file a run still consumes is detached (kept); the rest are deleted
    // (row + counter + storage). Must precede the delete — the chat_session_id FK
    // cascade would otherwise wipe the files (and their links) first.
    //
    // Both run in ONE transaction: the teardown and the `chat_sessions` delete
    // commit atomically, so an attachment materializing between them can no
    // longer be cascade-deleted with no storage-deletion outbox job (orphaned
    // S3 object). The teardown locks the org row FOR UPDATE — the same
    // serialization point the materialize path takes — so the two serialize.
    await db.transaction(async (tx) => {
      await deps.cleanupSessionFiles(session.id, tx);
      await tx.delete(chatSessions).where(eq(chatSessions.id, session.id));
    });
    notifySessionUpdate(session.id, session.orgId, session.userId);
    return c.body(null, 204);
  });

  // POST /api/chat — the conversational loop (AI SDK UIMessage stream).
  // 20/min: every call fans out into metered LLM traffic. The server is the
  // single writer of messages (user before inference, assistant on finalize) —
  // there is no client message-write endpoint.
  router.post("/api/chat", rateLimited(20), requireModulePermission("chat", "write"), (c) =>
    handleChatStream(c, deps),
  );

  // GET /api/chat/sessions/:id/stream — reconnect to the in-flight turn (resume).
  // The client's native AI-SDK reconnect (`useChat({ resume: true })`) calls this
  // on mount: when a turn is generating we replay its recorded bytes + live tail
  // (so a mid-inference reload continues exactly where it was); otherwise 204.
  router.get(
    "/api/chat/sessions/:id/stream",
    rateLimited(120),
    requireModulePermission("chat", "read"),
    async (c) => {
      // A brand-new, not-yet-sent conversation has no row — nothing to resume.
      const session = await findOwnedSession(c.req.param("id"), sessionScope(c));
      if (!session?.activeStreamId) return c.body(null, 204);
      const stream = await getResumableContext().resume(session.activeStreamId);
      if (!stream) {
        // No recording under the marker's id. Two things look like this: a
        // live turn whose recording is not there (acquisition still a few
        // statements away, acquisition failed, key evicted), and a marker
        // whose producer is gone (crash, restart, an in-memory store on a
        // previous process). The marker's age tells them apart —
        // `setActiveStream` stamps `updated_at` with the marker, and no live
        // turn outlives `STALE_MARKER_MIN_AGE_MS` (the turn deadline plus a
        // teardown allowance). A young marker is left alone: 204.
        const markerAgeMs = Date.now() - session.updatedAt.getTime();
        if (markerAgeMs < STALE_MARKER_MIN_AGE_MS) return c.body(null, 204);
        // Stale: nothing will ever clear it from here on — `clearActiveStream`
        // runs from the producer's own teardown, which is the thing that never
        // happened. Left set, the sidebar polls a spinner forever and
        // `persistNotice` refuses the session forever. Clear it now — guarded
        // by the stream id, so a newer turn that already re-marked the session
        // is untouched — and say so once: the next GET finds no marker and
        // never reaches this branch.
        await clearActiveStream(session.id, session.activeStreamId);
        logger.info("chat resume: cleared stale active stream marker", {
          chatSessionId: session.id,
          streamId: session.activeStreamId,
        });
        return c.body(null, 204);
      }
      return new Response(stream, { headers: UI_MESSAGE_STREAM_HEADERS });
    },
  );

  // POST /api/chat/sessions/:id/stop — explicit stop (≠ disconnect): abort the
  // session's in-flight generation. Keyed by session id (the conversation the
  // client knows); the live stream id is resolved server-side.
  router.post(
    "/api/chat/sessions/:id/stop",
    rateLimited(60),
    requireModulePermission("chat", "write"),
    async (c) => {
      const session = await getOwnedSession(c.req.param("id"), sessionScope(c));
      if (session.activeStreamId) stopStream(session.activeStreamId);
      return c.body(null, 204);
    },
  );

  return router;
}
