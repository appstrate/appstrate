// SPDX-License-Identifier: Apache-2.0

/**
 * Chat API — session CRUD + history READ, and the enforced skills (names).
 *
 * There is ONE kind of conversation: it belongs to the organization and its
 * author, under `/api/orgs/:orgId/chat/*`. Its nullable ORIGIN space
 * (`chat_sessions.space_id`) is not an owner; the TOUCHED set (the origin space
 * plus `chat_session_spaces`) is what spaces filter it by, and it is visible to its
 * author only while they reach, with `chat:read`, every space of that set. A
 * conversation may be limited (`restricted`) to its origin space. Sessions are
 * personal: every query filters by (orgId, userId).
 *
 * Persistence is server-authoritative and has exactly TWO writers, both in
 * `persistence.ts`. `POST /api/orgs/:orgId/chat` is the only one on a request
 * path: it stores the user turn before inference and the assistant turn when the
 * stream finalizes (`finalize-stream.ts`). The second is `persistNotice`, which
 * posts a server-authored message into a session with NO live turn — today only
 * the orphaned-run reconciliation (`run-reconcile.ts`), driven by the
 * `onRunStatusChange` event. The two never overlap: `persistNotice` takes the
 * session row's lock and refuses while `active_stream_id` is set, so a turn
 * owns its conversation from start to finalize. The routes below therefore
 * never accept a message — `GET …/sessions/:id` returns the stored
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
import { and, asc, desc, eq, ilike, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { chatMessages, chatSessions } from "@appstrate/db/schema";
import {
  PERMISSION_REQUIREMENT_MARKER,
  requireModulePermission,
} from "@appstrate/core/permissions";
import { conflict, forbidden, invalidRequest, notFound } from "@appstrate/core/api-errors";
import { listResponse, parseListLimit } from "@appstrate/core/list-query";
import { readJsonBody } from "@appstrate/core/request-body";
import { setCursorLinkHeader } from "@appstrate/core/pagination-link";
import { UI_MESSAGE_STREAM_HEADERS } from "ai";
import { handleChatStream } from "./chat-stream.ts";
import type { ChatEnv } from "./prompt.ts";
import { stopStream } from "./stop-registry.ts";
import { clearActiveStream, getResumableContext, STALE_MARKER_MIN_AGE_MS } from "./resumable.ts";
import { mintSessionId } from "./session-id.ts";
import { notifySessionUpdate } from "./realtime.ts";
import { logger } from "./logger.ts";
import { createSession, sessionVisible, touchedSpaceIds, touchedUnder } from "./persistence.ts";
import {
  readableSpaceIds,
  spacesHolding,
  canActIn,
  conversationOrigin,
  actingSpaces,
  type ChatPermission,
  type ChatPlatformDeps,
} from "./platform-services.ts";

const SESSIONS_PAGE_SIZE = 100;

const SESSIONS_SEARCH_MAX = 200;

/**
 * `%`, `_` and `\` taken as typed (Postgres' default LIKE escape is the
 * backslash). Mirrors `apps/api/src/lib/like-pattern.ts`, which a module
 * package cannot import.
 */
function likeContains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

export const createSessionSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  /** The conversation's origin space: the space selected when it is created. */
  spaceId: z.string().min(1).optional(),
  /** Limited to the origin space (`spaceId` required). */
  restricted: z.boolean().optional(),
});

export const updateSessionSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    /** Limit (`true`, needs an origin space the caller can act in) or lift (`false`) it. */
    restricted: z.boolean().optional(),
  })
  .refine((body) => body.title !== undefined || body.restricted !== undefined, {
    error: "title or restricted is required",
  });

type SessionRow = typeof chatSessions.$inferSelect;
type MessageRow = typeof chatMessages.$inferSelect;

function toSessionDto(row: SessionRow, touchedSpaceIds: readonly string[]) {
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
    skill_mode: row.skillMode,
    pinned_skills: row.pinnedSkills,
    spaceId: row.spaceId,
    restricted: row.restricted,
    space_ids: touchedSpaceIds,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The DTOs of `rows`, the touched set of all of them read in ONE query. */
async function toSessionDtos(rows: SessionRow[]) {
  const touched = await touchedSpaceIds(rows.map((row) => row.id));
  return rows.map((row) => toSessionDto(row, touched.get(row.id) ?? []));
}

function toMessageDto(row: MessageRow) {
  return {
    id: row.messageId,
    content: row.content,
  };
}

/**
 * What a session query is scoped to: the author alone (ownership is part of the
 * query, not a display filter), and the spaces they read with `chat:read` — a
 * session is visible while every space of its touched set is among them.
 */
interface SessionScope {
  orgId: string;
  userId: string;
  readable: readonly string[];
}

/** The sessions the scope can OPEN, and list: its author's visible ones. */
const openableBy = (scope: SessionScope): SQL =>
  and(
    eq(chatSessions.orgId, scope.orgId),
    eq(chatSessions.userId, scope.userId),
    sessionVisible(scope.readable),
  )!;

async function findOwnedSession(id: string, scope: SessionScope): Promise<SessionRow | undefined> {
  const [session] = await db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.id, id), openableBy(scope)))
    .limit(1);
  return session;
}

async function getOwnedSession(id: string, scope: SessionScope): Promise<SessionRow> {
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

/** The shape `requireModulePermission` returns — what a route's permission guard is. */
type PermissionGuard = ReturnType<typeof requireModulePermission>;

export function createChatRouter(deps: ChatPlatformDeps) {
  const router = new Hono<ChatEnv>();

  // Platform per-route limiter (the turn fans out into metered LLM
  // traffic). The platform always supplies it via deps — no unlimited fallback.
  const rateLimited = (limitPerMinute: number): MiddlewareHandler => deps.rateLimit(limitPerMinute);

  // The chat enters no space, so the space-level guard could never pass: a route is
  // admitted when SOME space the caller reaches grants its permission (the platform's
  // reach: persona and credential ceiling included; an end-user is refused there), and
  // each handler then narrows by the spaces the caller reads. The reach is read once,
  // here, and rides the context.
  router.use("/api/orgs/:orgId/chat/*", async (c, next) => {
    const orgId = c.req.param("orgId");
    // Set by the org-path context for a member (or pinned by the credential); absent otherwise.
    if (c.get("orgId") !== orgId) {
      throw forbidden("Not a member of this organization");
    }
    // Like every `/api/orgs/:orgId/*` route, this reads no `X-Space-Id`: a request that
    // carries one (the MCP router adds it to every dispatched hop) is served all the same.
    const { spaces, pinned } = await deps.reachableSpaces(c, orgId);
    // A credential pinned to one space cannot hold a conversation: its spaces are the
    // caller's, whichever the credential would let a call name.
    if (pinned) {
      throw forbidden("A credential pinned to a space cannot use the organization chat endpoint.");
    }
    c.set("reachable", spaces);
    return next();
  });

  // `acting`: the route starts a turn or a conversation, so it needs a space the turn may act
  // in, not just any `chat:write`. Managing an existing conversation needs the permission alone.
  const guard = (permission: ChatPermission, acting = false): PermissionGuard => {
    const check: PermissionGuard = async (c, next) => {
      // The guard type sees the context through its `get` alone; it is the router's own.
      const reachable = (c as Context<ChatEnv>).get("reachable");
      const holders = acting ? actingSpaces(reachable) : spacesHolding(reachable, permission);
      if (holders.length === 0) {
        throw forbidden(
          acting
            ? "You hold chat:write, chat:read and mcp:read together in no space of this organization."
            : `You hold ${permission} in no space of this organization.`,
        );
      }
      return next();
    };
    // The requirement the route table reads back, as `requireModulePermission` stamps it.
    return Object.defineProperty(check, PERMISSION_REQUIREMENT_MARKER, { value: permission });
  };

  // Registered with literal paths (what verify:openapi reads).
  const handlers = createSessionHandlers(deps);
  router.get("/api/orgs/:orgId/chat/sessions", guard("chat:read"), handlers.list);
  router.post(
    "/api/orgs/:orgId/chat/sessions",
    rateLimited(30),
    guard("chat:write", true),
    handlers.create,
  );
  router.get("/api/orgs/:orgId/chat/sessions/:id", guard("chat:read"), handlers.get);
  router.patch("/api/orgs/:orgId/chat/sessions/:id", guard("chat:write"), handlers.update);
  router.put(
    "/api/orgs/:orgId/chat/sessions/:id/read",
    rateLimited(120),
    guard("chat:write"),
    handlers.markRead,
  );
  router.delete("/api/orgs/:orgId/chat/sessions/:id", guard("chat:write"), handlers.remove);
  router.get(
    "/api/orgs/:orgId/chat/sessions/:id/stream",
    rateLimited(120),
    guard("chat:read"),
    handlers.resume,
  );
  router.post(
    "/api/orgs/:orgId/chat/sessions/:id/stop",
    rateLimited(60),
    guard("chat:write"),
    handlers.stop,
  );

  // GET …/enforced-skills?spaceId= — the names of a space's enforced skills, from the
  // database: a member without `skills:read` may call it. The composer shows them for a
  // new conversation in the selected space, or for an existing conversation's origin.
  router.get(
    "/api/orgs/:orgId/chat/enforced-skills",
    rateLimited(120),
    guard("chat:read"),
    async (c) => {
      const spaceId = c.req.query("spaceId");
      if (!spaceId) throw invalidRequest("spaceId is required", "spaceId");
      if (!sessionScope(c).readable.includes(spaceId)) {
        throw invalidRequest("spaceId must be a space you can read chats in", "spaceId");
      }
      const skills = await deps.listEnforcedSkills(c.get("orgId"), spaceId);
      return c.json({
        object: "list",
        data: skills.map(({ packageId, name, version }) => ({ id: packageId, name, version })),
      });
    },
  );

  // POST …/chat — the conversational loop (AI SDK UIMessage stream).
  // 20/min: every call fans out into metered LLM traffic. The server is the
  // single writer of messages (user before inference, assistant on finalize) —
  // there is no client message-write endpoint.
  router.post("/api/orgs/:orgId/chat", rateLimited(20), guard("chat:write", true), (c) =>
    handleChatStream(c, deps),
  );

  return router;
}

/** The scope of a request: its author, and the spaces they read with `chat:read`. */
function sessionScope(c: Context<ChatEnv>): SessionScope {
  return {
    orgId: c.get("orgId"),
    userId: c.get("user").id,
    readable: readableSpaceIds(c.get("reachable")),
  };
}

/** The session handlers — CRUD, read marker, resume, stop. */
function createSessionHandlers(deps: ChatPlatformDeps) {
  return {
    // GET …/sessions — most recent activity first, keyset on `(updatedAt, id)`;
    // the bound is the cursor ROW, compared in SQL at full precision.
    list: async (c: Context<ChatEnv>) => {
      const scope = sessionScope(c);
      const limit = parseListLimit(c, { defaultLimit: SESSIONS_PAGE_SIZE });
      // `?spaceId=` keeps the conversations whose touched set holds that space or is empty, in a space the caller
      // must read: a space outside their reach is refused, like any unknown filter value.
      const spaceId = c.req.query("spaceId");
      if (spaceId !== undefined && !scope.readable.includes(spaceId)) {
        throw invalidRequest("spaceId must be a space you can read chats in", "spaceId");
      }
      const listed = and(
        openableBy(scope),
        spaceId === undefined ? undefined : touchedUnder(spaceId),
      )!;
      const conditions: SQL[] = [listed];
      // `?q=` narrows by title; blank = no filter. Untitled rows never match
      // (`NULL ILIKE …` is not true). The cursor stays any row of the filtered list.
      const search = c.req.query("q")?.trim();
      if (search && search.length > SESSIONS_SEARCH_MAX) {
        throw invalidRequest(`q must be ${SESSIONS_SEARCH_MAX} characters or fewer`, "q");
      }
      if (search) conditions.push(ilike(chatSessions.title, likeContains(search)));
      const startingAfter = c.req.query("startingAfter");
      if (startingAfter) {
        const [cursor] = await db
          .select({ id: chatSessions.id })
          .from(chatSessions)
          .where(and(eq(chatSessions.id, startingAfter), listed))
          .limit(1);
        if (!cursor) {
          throw invalidRequest(
            "startingAfter must be the id of one of your sessions in this list",
            "startingAfter",
          );
        }
        conditions.push(
          sql`(${chatSessions.updatedAt}, ${chatSessions.id}) < (select cur.updated_at, cur.id from ${chatSessions} cur where cur.id = ${startingAfter})`,
        );
      }
      const rows = await db
        .select()
        .from(chatSessions)
        .where(and(...conditions))
        .orderBy(desc(chatSessions.updatedAt), desc(chatSessions.id))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      setCursorLinkHeader({
        c,
        publicOrigin: deps.publicOrigin,
        hasMore,
        lastId: page.at(-1)?.id,
      });
      return c.json(listResponse(await toSessionDtos(page), { hasMore }));
    },

    // POST …/sessions — start a new conversation, with its origin space and limit
    create: async (c: Context<ChatEnv>) => {
      const data = await readJsonBody(c, createSessionSchema, { allowEmpty: true });
      const origin = conversationOrigin(c.get("reachable"), data);
      const row = await createSession({
        id: mintSessionId(),
        orgId: c.get("orgId"),
        userId: c.get("user").id,
        title: data.title ?? null,
        spaceId: origin?.spaceId ?? null,
        restricted: origin?.restricted ?? false,
      });
      notifySessionUpdate(row.id, row.orgId, row.userId);
      const [dto] = await toSessionDtos([row]);
      return c.json(dto, 201);
    },

    // GET …/sessions/:id — the conversation's messages, in seq order (history load)
    get: async (c: Context<ChatEnv>) => {
      const session = await getOwnedSession(c.req.param("id")!, sessionScope(c));
      const [dto] = await toSessionDtos([session]);
      const messages = await loadMessages(session.id);
      return c.json({ ...dto, messages: messages.map(toMessageDto) });
    },

    // PATCH …/sessions/:id — rename, limit to the origin space, or lift the limit
    update: async (c: Context<ChatEnv>) => {
      const session = await getOwnedSession(c.req.param("id")!, sessionScope(c));
      const { title, restricted } = await readJsonBody(c, updateSessionSchema);
      // Limiting needs an origin space the caller can still act in; lifting is always allowed.
      if (restricted && !canActIn(c.get("reachable"), session.spaceId)) {
        throw invalidRequest(
          "restricted needs an origin space this conversation can act in",
          "restricted",
        );
      }
      // A turn in flight keeps the reach it was minted with, so the limit changes between turns.
      const limitChanges = restricted !== undefined && restricted !== session.restricted;
      const updated = await db
        .update(chatSessions)
        .set({
          ...(title === undefined ? {} : { title }),
          ...(restricted === undefined ? {} : { restricted }),
          // Renaming reorders the sidebar; limiting or lifting the limit does not (as pins don't).
          ...(title === undefined ? {} : { updatedAt: new Date() }),
        })
        .where(
          and(
            eq(chatSessions.id, session.id),
            limitChanges ? isNull(chatSessions.activeStreamId) : undefined,
          ),
        )
        .returning({ id: chatSessions.id });
      if (updated.length === 0) {
        throw limitChanges
          ? conflict("chat_turn_in_flight", "The limit cannot change while a turn is running.")
          : notFound("Chat session not found");
      }
      notifySessionUpdate(session.id, session.orgId, session.userId);
      return c.body(null, 204);
    },

    // PUT …/sessions/:id/read — mark the session read (idempotent).
    // Advances the read marker up to the latest known watermark, monotonically
    // (GREATEST) so a late/replayed call can never regress it — and deliberately
    // NOT `updatedAt`, so opening a conversation never reorders the sidebar.
    // Mirrors PUT /notifications/:id/read. The SSE signal syncs the cleared
    // badge to the owner's other devices instantly.
    markRead: async (c: Context<ChatEnv>) => {
      const session = await getOwnedSession(c.req.param("id")!, sessionScope(c));
      await db
        .update(chatSessions)
        .set({
          lastReadSeq: sql`GREATEST(coalesce(${chatSessions.lastReadSeq}, 0), coalesce(${chatSessions.lastAssistantSeq}, 0))`,
        })
        .where(eq(chatSessions.id, session.id));
      notifySessionUpdate(session.id, session.orgId, session.userId);
      return c.body(null, 204);
    },

    // DELETE …/sessions/:id — delete a session (entries cascade)
    remove: async (c: Context<ChatEnv>) => {
      const session = await getOwnedSession(c.req.param("id")!, sessionScope(c));
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
        await deps.cleanupSessionFiles(session.id, session.orgId, tx);
        await tx.delete(chatSessions).where(eq(chatSessions.id, session.id));
      });
      notifySessionUpdate(session.id, session.orgId, session.userId);
      return c.body(null, 204);
    },

    // GET …/sessions/:id/stream — reconnect to the in-flight turn (resume).
    // The client's native AI-SDK reconnect (`useChat({ resume: true })`) calls this
    // on mount: when a turn is generating we replay its recorded bytes + live tail
    // (so a mid-inference reload continues exactly where it was); otherwise 204.
    resume: async (c: Context<ChatEnv>) => {
      // A brand-new, not-yet-sent conversation has no row — nothing to resume.
      const session = await findOwnedSession(c.req.param("id")!, sessionScope(c));
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

    // POST …/sessions/:id/stop — explicit stop (≠ disconnect): abort the
    // session's in-flight generation. Keyed by session id (the conversation the
    // client knows); the live stream id is resolved server-side.
    stop: async (c: Context<ChatEnv>) => {
      const session = await getOwnedSession(c.req.param("id")!, sessionScope(c));
      if (session.activeStreamId) stopStream(session.activeStreamId);
      return c.body(null, 204);
    },
  };
}
