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
 * Rate limiting: `services.http.rateLimit` (platform capability) — wired
 * by index.ts after init, see `setRateLimitFactory`.
 */

import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { chatMessages, chatSessions } from "@appstrate/db/schema";
import { requireModulePermission } from "@appstrate/core/permissions";
import { notFound, parseBody } from "@appstrate/core/api-errors";
import { handleChatStream } from "./chat-stream.ts";
import { handleGenerateTitle } from "./title.ts";

/** Minimal Hono Env mirroring what the platform auth pipeline sets. */
type ChatEnv = {
  Variables: {
    user: { id: string; email: string; name: string };
    orgId: string;
  };
};

export const createSessionSchema = z.object({
  title: z.string().min(1).max(200).optional(),
});

export const renameSessionSchema = z.object({
  title: z.string().min(1).max(200),
});

/** One tree node from the history adapter — `content` is opaque to us. */
export const messageEntrySchema = z.object({
  id: z.string().min(1).max(200),
  parent_id: z.string().max(200).nullable(),
  format: z.string().min(1).max(100),
  content: z.unknown(),
});

function newSessionId(): string {
  return `chs_${crypto.randomUUID().replaceAll("-", "")}`;
}

type SessionRow = typeof chatSessions.$inferSelect;
type MessageRow = typeof chatMessages.$inferSelect;

function toSessionDto(row: SessionRow) {
  return {
    object: "chat_session" as const,
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toEntryDto(row: MessageRow) {
  return {
    id: row.messageId,
    parent_id: row.parentId,
    format: row.format,
    content: row.content,
  };
}

async function getOwnedSession(id: string, orgId: string, userId: string): Promise<SessionRow> {
  const [session] = await db
    .select()
    .from(chatSessions)
    .where(
      and(eq(chatSessions.id, id), eq(chatSessions.orgId, orgId), eq(chatSessions.userId, userId)),
    )
    .limit(1);
  if (!session) throw notFound("Chat session not found");
  return session;
}

async function loadEntries(sessionId: string): Promise<MessageRow[]> {
  return db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(asc(chatMessages.seq));
}

/** First user entry's text, trimmed — best-effort over the opaque content. */
function deriveTitle(entries: MessageRow[]): string | null {
  for (const entry of entries) {
    const content = entry.content as { role?: string; parts?: unknown[] };
    if (content?.role !== "user" || !Array.isArray(content.parts)) continue;
    const text = content.parts
      .map((p) =>
        p && typeof p === "object" && (p as { type?: string }).type === "text"
          ? ((p as { text?: string }).text ?? "")
          : "",
      )
      .join("")
      .trim();
    if (text) return text.length > 60 ? `${text.slice(0, 57)}…` : text;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rate limiting — injected platform capability (set by index.ts at init).
// Before init (or on platforms without the capability) routes run unlimited.
// ---------------------------------------------------------------------------

type RateLimitFactory = (limitPerMinute: number) => MiddlewareHandler;
let rateLimitFactory: RateLimitFactory | null = null;

export function setRateLimitFactory(factory: RateLimitFactory | null): void {
  rateLimitFactory = factory;
}

function rateLimited(limitPerMinute: number): MiddlewareHandler {
  return (c, next) => (rateLimitFactory ? rateLimitFactory(limitPerMinute)(c, next) : next());
}

export function createChatRouter() {
  const router = new Hono<ChatEnv>();

  // GET /api/chat/sessions — list the caller's sessions in the current org
  router.get("/api/chat/sessions", requireModulePermission("chat", "read"), async (c) => {
    const rows = await db
      .select()
      .from(chatSessions)
      .where(and(eq(chatSessions.orgId, c.get("orgId")), eq(chatSessions.userId, c.get("user").id)))
      .orderBy(desc(chatSessions.updatedAt))
      .limit(100);
    return c.json({ object: "list", data: rows.map(toSessionDto), hasMore: false });
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
          id: newSessionId(),
          orgId: c.get("orgId"),
          userId: c.get("user").id,
          title: data.title ?? null,
        })
        .returning();
      return c.json(toSessionDto(row!), 201);
    },
  );

  // GET /api/chat/sessions/:id — the conversation's tree nodes (history load)
  router.get("/api/chat/sessions/:id", requireModulePermission("chat", "read"), async (c) => {
    const session = await getOwnedSession(c.req.param("id"), c.get("orgId"), c.get("user").id);
    const entries = await loadEntries(session.id);
    return c.json({ ...toSessionDto(session), messages: entries.map(toEntryDto) });
  });

  // PATCH /api/chat/sessions/:id — rename
  router.patch("/api/chat/sessions/:id", requireModulePermission("chat", "write"), async (c) => {
    const session = await getOwnedSession(c.req.param("id"), c.get("orgId"), c.get("user").id);
    const { title } = parseBody(renameSessionSchema, await c.req.json().catch(() => null));
    await db
      .update(chatSessions)
      .set({ title, updatedAt: new Date() })
      .where(eq(chatSessions.id, session.id));
    return c.body(null, 204);
  });

  // DELETE /api/chat/sessions/:id — delete a session (entries cascade)
  router.delete("/api/chat/sessions/:id", requireModulePermission("chat", "write"), async (c) => {
    const session = await getOwnedSession(c.req.param("id"), c.get("orgId"), c.get("user").id);
    await db.delete(chatSessions).where(eq(chatSessions.id, session.id));
    return c.body(null, 204);
  });

  // POST /api/chat/sessions/:id/messages — append/upsert one tree node
  // (assistant-ui history adapter `append`/`update`).
  router.post(
    "/api/chat/sessions/:id/messages",
    rateLimited(120),
    requireModulePermission("chat", "write"),
    async (c) => {
      const session = await getOwnedSession(c.req.param("id"), c.get("orgId"), c.get("user").id);
      const entry = parseBody(messageEntrySchema, await c.req.json().catch(() => null));

      await db
        .insert(chatMessages)
        .values({
          sessionId: session.id,
          messageId: entry.id,
          parentId: entry.parent_id,
          format: entry.format,
          content: (entry.content ?? null) as typeof chatMessages.$inferInsert.content,
        })
        .onConflictDoUpdate({
          target: [chatMessages.sessionId, chatMessages.messageId],
          set: {
            parentId: entry.parent_id,
            content: (entry.content ?? null) as typeof chatMessages.$inferInsert.content,
            format: entry.format,
          },
        });

      const title = session.title ?? deriveTitle(await loadEntries(session.id));
      await db
        .update(chatSessions)
        .set({ updatedAt: new Date(), ...(title !== session.title ? { title } : {}) })
        .where(eq(chatSessions.id, session.id));
      return c.body(null, 204);
    },
  );

  // POST /api/chat — the conversational loop (AI SDK UIMessage stream).
  // 20/min: every call fans out into metered LLM traffic.
  router.post(
    "/api/chat",
    rateLimited(20),
    requireModulePermission("chat", "write"),
    handleChatStream,
  );

  // POST /api/chat/title — short LLM-generated conversation title.
  router.post(
    "/api/chat/title",
    rateLimited(20),
    requireModulePermission("chat", "write"),
    handleGenerateTitle,
  );

  return router;
}
