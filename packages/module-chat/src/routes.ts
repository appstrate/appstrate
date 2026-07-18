// SPDX-License-Identifier: Apache-2.0

/**
 * Chat API — session CRUD + opaque history entries.
 *
 * Sessions are personal: every query filters by (orgId, userId). The
 * message store follows assistant-ui's NATIVE history-adapter contract
 * (ported from the appstrate-chat satellite): the client encodes each tree
 * node with its format adapter and POSTs `{ id, parent_id, format,
 * content }`; the server stores it verbatim (upsert on the client id) and
 * only peeks inside for a best-effort title. The live conversation flows
 * through `POST /api/chat` (streaming) — the history endpoints are pure
 * persistence.
 *
 * Rate limiting: `services.http.rateLimit` (platform capability), captured into
 * the router's `ChatPlatformDeps` at module init (see index.ts).
 */

import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { chatMessages, chatSessions } from "@appstrate/db/schema";
import { requireModulePermission } from "@appstrate/core/permissions";
import { notFound, parseBody } from "@appstrate/core/api-errors";
import { UI_MESSAGE_STREAM_HEADERS } from "ai";
import { handleChatStream, type ChatEnv } from "./chat-stream.ts";
import { stopStream } from "./stop-registry.ts";
import { getResumableContext } from "./resumable.ts";
import { mintSessionId } from "./session-id.ts";
import { notifySessionUpdate } from "./realtime.ts";
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
    parent_id: row.parentId,
    format: row.format,
    content: row.content,
  };
}

async function findOwnedSession(
  id: string,
  orgId: string,
  userId: string,
): Promise<SessionRow | undefined> {
  const [session] = await db
    .select()
    .from(chatSessions)
    .where(
      and(eq(chatSessions.id, id), eq(chatSessions.orgId, orgId), eq(chatSessions.userId, userId)),
    )
    .limit(1);
  return session;
}

async function getOwnedSession(id: string, orgId: string, userId: string): Promise<SessionRow> {
  const session = await findOwnedSession(id, orgId, userId);
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

  // Platform per-route limiter (POST /api/chat fans out into metered LLM
  // traffic). The platform always supplies it via deps — no unlimited fallback.
  const rateLimited = (limitPerMinute: number): MiddlewareHandler => deps.rateLimit(limitPerMinute);

  // GET /api/chat/sessions — list the caller's sessions in the current org
  router.get("/api/chat/sessions", requireModulePermission("chat", "read"), async (c) => {
    // Fetch one past the page so `hasMore` reflects reality: previously it was
    // hardcoded `false`, so a caller with more than a page of sessions had no
    // signal that older conversations existed beyond the window.
    const rows = await db
      .select()
      .from(chatSessions)
      .where(and(eq(chatSessions.orgId, c.get("orgId")), eq(chatSessions.userId, c.get("user").id)))
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
      const [row] = await db
        .insert(chatSessions)
        .values({
          id: mintSessionId(),
          orgId: c.get("orgId"),
          userId: c.get("user").id,
          title: data.title ?? null,
        })
        .returning();
      await notifySessionUpdate(row!.id, row!.orgId, row!.userId);
      return c.json(toSessionDto(row!), 201);
    },
  );

  // GET /api/chat/sessions/:id — the conversation's tree nodes (history load)
  router.get("/api/chat/sessions/:id", requireModulePermission("chat", "read"), async (c) => {
    const session = await getOwnedSession(c.req.param("id"), c.get("orgId"), c.get("user").id);
    const messages = await loadMessages(session.id);
    return c.json({ ...toSessionDto(session), messages: messages.map(toMessageDto) });
  });

  // PATCH /api/chat/sessions/:id — rename
  router.patch("/api/chat/sessions/:id", requireModulePermission("chat", "write"), async (c) => {
    const session = await getOwnedSession(c.req.param("id"), c.get("orgId"), c.get("user").id);
    const { title } = parseBody(renameSessionSchema, await c.req.json().catch(() => null));
    await db
      .update(chatSessions)
      .set({ title, updatedAt: new Date() })
      .where(eq(chatSessions.id, session.id));
    await notifySessionUpdate(session.id, session.orgId, session.userId);
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
      const session = await getOwnedSession(c.req.param("id"), c.get("orgId"), c.get("user").id);
      await db
        .update(chatSessions)
        .set({
          lastReadSeq: sql`GREATEST(coalesce(${chatSessions.lastReadSeq}, 0), coalesce(${chatSessions.lastAssistantSeq}, 0))`,
        })
        .where(eq(chatSessions.id, session.id));
      await notifySessionUpdate(session.id, session.orgId, session.userId);
      return c.body(null, 204);
    },
  );

  // DELETE /api/chat/sessions/:id — delete a session (entries cascade)
  router.delete("/api/chat/sessions/:id", requireModulePermission("chat", "write"), async (c) => {
    const session = await getOwnedSession(c.req.param("id"), c.get("orgId"), c.get("user").id);
    await db.delete(chatSessions).where(eq(chatSessions.id, session.id));
    await notifySessionUpdate(session.id, session.orgId, session.userId);
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
      const session = await findOwnedSession(c.req.param("id"), c.get("orgId"), c.get("user").id);
      if (!session?.activeStreamId) return c.body(null, 204);
      const stream = await getResumableContext().resume(session.activeStreamId);
      // Stale id (producer gone, e.g. after a crash) → nothing to resume.
      if (!stream) return c.body(null, 204);
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
      const session = await getOwnedSession(c.req.param("id"), c.get("orgId"), c.get("user").id);
      if (session.activeStreamId) stopStream(session.activeStreamId);
      return c.body(null, 204);
    },
  );

  return router;
}
