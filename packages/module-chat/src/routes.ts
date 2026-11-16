// SPDX-License-Identifier: Apache-2.0

/**
 * Chat API — session CRUD + history READ, and the space's enforced skills (names).
 *
 * Sessions are personal: every query filters by (orgId, userId). They come in
 * two kinds, fixed at creation. A SPACE session (`space_id` set) is served by
 * `/api/chat/*`, which enters the space named by `X-Space-Id`. An ORGANIZATION
 * session (`space_id` NULL, opened from the overview) is served by the same
 * handlers mounted at `/api/orgs/:orgId/chat/*`, which enters no space: it is
 * visible to its author only while they reach, with `chat:read`, every space it
 * touched (`chat_session_spaces`). The organization mount also lists the space
 * sessions of every space the reader reaches.
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
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { chatMessages, chatSessions, chatSessionSpaces } from "@appstrate/db/schema";
import {
  enterSpaceContext,
  PERMISSION_REQUIREMENT_MARKER,
  requireModulePermission,
} from "@appstrate/core/permissions";
import { forbidden, invalidRequest, notFound } from "@appstrate/core/api-errors";
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
import { organizationSessionVisible } from "./persistence.ts";
import {
  enforcedSkillsOf,
  spacesHolding,
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
});

export const renameSessionSchema = z.object({
  title: z.string().min(1).max(200),
});

type SessionRow = typeof chatSessions.$inferSelect;
type MessageRow = typeof chatMessages.$inferSelect;

function toSessionDto(row: SessionRow, touchedSpaceIds: readonly string[] = []) {
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
    space_ids: touchedSpaceIds,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The DTOs of `rows`, the touched spaces of their organization sessions read in ONE query. */
async function toSessionDtos(rows: SessionRow[]) {
  const organizationIds = rows.filter((row) => row.spaceId === null).map((row) => row.id);
  const touched = new Map<string, string[]>();
  if (organizationIds.length > 0) {
    const links = await db
      .select({ sessionId: chatSessionSpaces.sessionId, spaceId: chatSessionSpaces.spaceId })
      .from(chatSessionSpaces)
      .where(inArray(chatSessionSpaces.sessionId, organizationIds))
      .orderBy(asc(chatSessionSpaces.createdAt), asc(chatSessionSpaces.spaceId));
    for (const { sessionId, spaceId } of links) {
      touched.set(sessionId, [...(touched.get(sessionId) ?? []), spaceId]);
    }
  }
  return rows.map((row) => toSessionDto(row, touched.get(row.id)));
}

function toMessageDto(row: MessageRow) {
  return {
    id: row.messageId,
    content: row.content,
  };
}

/**
 * What a session query is scoped to. A session belongs to ONE space (RBAC spec
 * §5) or, for an organization session, to the author alone; either way the
 * owner is part of ownership, not a display filter. `readable` is the set of
 * spaces the organization mount's caller reaches with `chat:read`.
 */
type SessionScope = { orgId: string; userId: string } & (
  { spaceId: string } | { spaceId: null; readable: readonly string[] }
);

const ownedBy = (scope: SessionScope): SQL =>
  and(eq(chatSessions.orgId, scope.orgId), eq(chatSessions.userId, scope.userId))!;

/** The sessions the scope can OPEN: its space's, or its visible organization sessions. */
function openableBy(scope: SessionScope): SQL {
  return and(
    ownedBy(scope),
    scope.spaceId === null
      ? organizationSessionVisible(scope.readable)
      : eq(chatSessions.spaceId, scope.spaceId),
  )!;
}

/**
 * The sessions the scope LISTS: what it opens, and on the organization mount
 * also the space sessions of every space it reads.
 */
function listedBy(scope: SessionScope): SQL {
  if (scope.spaceId !== null) return openableBy(scope);
  return and(
    ownedBy(scope),
    or(
      inArray(chatSessions.spaceId, [...scope.readable]),
      organizationSessionVisible(scope.readable),
    ),
  )!;
}

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

/**
 * How one mount of the session handlers enters its scope: the permission guard
 * of each route and the {@link SessionScope} its handlers query with.
 */
/** The shape `requireModulePermission` returns — what a route's permission guard is. */
type PermissionGuard = ReturnType<typeof requireModulePermission>;

interface SessionMount {
  guard(action: "read" | "write"): PermissionGuard;
  scope(c: Context<ChatEnv>): Promise<SessionScope>;
}

/** The space a space-mount request entered. */
function spaceOf(c: Context<ChatEnv>): string {
  const scope = c.get("chatScope");
  if (scope.kind !== "space") throw new Error("a space route ran without a space scope");
  return scope.spaceId;
}

/** The reach of an organization-mount request. */
function organizationScope(c: Context<ChatEnv>) {
  const scope = c.get("chatScope");
  if (scope.kind !== "organization") {
    throw new Error("an organization route ran without an organization scope");
  }
  return scope;
}

export function createChatRouter(deps: ChatPlatformDeps) {
  const router = new Hono<ChatEnv>();

  // Platform per-route limiter (POST /api/chat fans out into metered LLM
  // traffic). The platform always supplies it via deps — no unlimited fallback.
  const rateLimited = (limitPerMinute: number): MiddlewareHandler => deps.rateLimit(limitPerMinute);

  // `chat` is a SPACE-level resource and `/api/chat` is not one of the core
  // space-scoped prefixes (that list is core-only by design), so this router
  // enters the space itself — otherwise `chat:read` / `chat:write` could never
  // be satisfied, since org permissions carry no space-level string
  // (RBAC spec §4.3). The space is the caller's pinned one, else `X-Space-Id`;
  // a caller that names neither gets a 400 (there is no default-space fallback
  // for a direct caller), and one with no role in the space is refused there.
  router.use("/api/chat/*", async (c, next) => {
    await enterSpaceContext(c);
    c.set("chatScope", { kind: "space", spaceId: c.get("space")!.id });
    return next();
  });

  const spaceMount: SessionMount = {
    guard: (action) => requireModulePermission("chat", action),
    scope: async (c) => ({
      orgId: c.get("orgId"),
      userId: c.get("user").id,
      spaceId: spaceOf(c),
    }),
  };

  // The organization mount enters no space, so the space-level guard could
  // never pass: a route is admitted when SOME space the caller reaches grants
  // its permission (the platform's reach: persona and credential ceiling
  // included; an end-user is refused there), and each handler then narrows by
  // the spaces the caller reads. The reach is read once, here, and rides the
  // context as the request's scope.
  router.use("/api/orgs/:orgId/chat/*", async (c, next) => {
    const orgId = c.req.param("orgId");
    // Set by the org-path context for a member (or pinned by the credential); absent otherwise.
    if (c.get("orgId") !== orgId) {
      throw forbidden("Not a member of this organization");
    }
    // Like every `/api/orgs/:orgId/*` route, this reads no `X-Space-Id`: a request that
    // carries one (the MCP router adds it to every dispatched hop) is served all the same.
    const { spaces, pinned } = await deps.reachableSpaces(c, orgId);
    // A credential pinned to one space cannot hold an organization session: the session's
    // spaces are the caller's, whichever the credential would let a call name.
    if (pinned) {
      throw forbidden("A credential pinned to a space cannot use the organization chat endpoint.");
    }
    c.set("chatScope", { kind: "organization", reachable: spaces });
    return next();
  });

  const reachGuard = (permission: ChatPermission): PermissionGuard => {
    const guard: PermissionGuard = async (c, next) => {
      // The guard type sees the context through its `get` alone; it is the router's own.
      const scope = (c as Context<ChatEnv>).get("chatScope");
      // Writing is acting: it needs a space the turn may act in, not just any `chat:write`.
      const holders =
        scope.kind !== "organization"
          ? []
          : permission === "chat:write"
            ? actingSpaces(scope.reachable)
            : spacesHolding(scope.reachable, permission);
      if (holders.length === 0) {
        throw forbidden(
          permission === "chat:write"
            ? "You hold chat:write, chat:read and mcp:read together in no space of this organization."
            : `You hold ${permission} in no space of this organization.`,
        );
      }
      return next();
    };
    // The requirement the route table reads back, as `requireModulePermission` stamps it.
    return Object.defineProperty(guard, PERMISSION_REQUIREMENT_MARKER, { value: permission });
  };

  const organizationMount: SessionMount = {
    guard: (action) => reachGuard(`chat:${action}`),
    scope: async (c) => ({
      orgId: c.get("orgId"),
      userId: c.get("user").id,
      spaceId: null,
      readable: organizationScope(c).reachable.flatMap((space) =>
        space.permissions.includes("chat:read") ? [space.id] : [],
      ),
    }),
  };

  // One handler set, registered once per mount under literal paths (what verify:openapi reads).
  const handlers = createSessionHandlers(deps);
  router.get("/api/chat/sessions", spaceMount.guard("read"), handlers.list(spaceMount));
  router.post(
    "/api/chat/sessions",
    rateLimited(30),
    spaceMount.guard("write"),
    handlers.create(spaceMount),
  );
  router.get("/api/chat/sessions/:id", spaceMount.guard("read"), handlers.get(spaceMount));
  router.patch("/api/chat/sessions/:id", spaceMount.guard("write"), handlers.rename(spaceMount));
  router.put(
    "/api/chat/sessions/:id/read",
    rateLimited(120),
    spaceMount.guard("write"),
    handlers.markRead(spaceMount),
  );
  router.delete("/api/chat/sessions/:id", spaceMount.guard("write"), handlers.remove(spaceMount));
  router.get(
    "/api/chat/sessions/:id/stream",
    rateLimited(120),
    spaceMount.guard("read"),
    handlers.resume(spaceMount),
  );
  router.post(
    "/api/chat/sessions/:id/stop",
    rateLimited(60),
    spaceMount.guard("write"),
    handlers.stop(spaceMount),
  );

  router.get(
    "/api/orgs/:orgId/chat/sessions",
    organizationMount.guard("read"),
    handlers.list(organizationMount),
  );
  router.post(
    "/api/orgs/:orgId/chat/sessions",
    rateLimited(30),
    organizationMount.guard("write"),
    handlers.create(organizationMount),
  );
  router.get(
    "/api/orgs/:orgId/chat/sessions/:id",
    organizationMount.guard("read"),
    handlers.get(organizationMount),
  );
  router.patch(
    "/api/orgs/:orgId/chat/sessions/:id",
    organizationMount.guard("write"),
    handlers.rename(organizationMount),
  );
  router.put(
    "/api/orgs/:orgId/chat/sessions/:id/read",
    rateLimited(120),
    organizationMount.guard("write"),
    handlers.markRead(organizationMount),
  );
  router.delete(
    "/api/orgs/:orgId/chat/sessions/:id",
    organizationMount.guard("write"),
    handlers.remove(organizationMount),
  );
  router.get(
    "/api/orgs/:orgId/chat/sessions/:id/stream",
    rateLimited(120),
    organizationMount.guard("read"),
    handlers.resume(organizationMount),
  );
  router.post(
    "/api/orgs/:orgId/chat/sessions/:id/stop",
    rateLimited(60),
    organizationMount.guard("write"),
    handlers.stop(organizationMount),
  );

  // GET …/enforced-skills — names only, from the database: a member without
  // `skills:read` may call it. Gated like the turn that injects them.
  const enforcedSkills: SessionHandler = async (c) => {
    const orgId = c.get("orgId");
    const skills = await enforcedSkillsOf(c.get("chatScope"), (spaceId) =>
      deps.listEnforcedSkills(orgId, spaceId),
    );
    return c.json({
      object: "list",
      data: skills.map(({ packageId, name, version }) => ({ id: packageId, name, version })),
    });
  };
  router.get(
    "/api/chat/enforced-skills",
    rateLimited(120),
    requireModulePermission("chat", "write"),
    enforcedSkills,
  );
  router.get(
    "/api/orgs/:orgId/chat/enforced-skills",
    rateLimited(120),
    organizationMount.guard("write"),
    enforcedSkills,
  );

  // POST …/chat — the conversational loop (AI SDK UIMessage stream).
  // 20/min: every call fans out into metered LLM traffic. The server is the
  // single writer of messages (user before inference, assistant on finalize) —
  // there is no client message-write endpoint.
  router.post("/api/chat", rateLimited(20), requireModulePermission("chat", "write"), (c) =>
    handleChatStream(c, deps),
  );
  router.post("/api/orgs/:orgId/chat", rateLimited(20), organizationMount.guard("write"), (c) =>
    handleChatStream(c, deps),
  );

  return router;
}

type SessionHandler = (c: Context<ChatEnv>) => Promise<Response>;

/**
 * The session handlers — CRUD, read marker, resume, stop — each built for a
 * {@link SessionMount}; one body serves both mounts. Registered with literal
 * paths so `verify:openapi` can read the route table.
 */
function createSessionHandlers(deps: ChatPlatformDeps) {
  return {
    // GET …/sessions — most recent activity first, keyset on `(updatedAt, id)`;
    // the bound is the cursor ROW, compared in SQL at full precision.
    list:
      (mount: SessionMount): SessionHandler =>
      async (c) => {
        const scope = await mount.scope(c);
        const limit = parseListLimit(c, { defaultLimit: SESSIONS_PAGE_SIZE });
        const conditions: SQL[] = [listedBy(scope)];
        // `?q=` narrows by title; blank = no filter. Untitled rows never match
        // (`NULL ILIKE …` is not true). The cursor stays any of the caller's listed rows.
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
            .where(and(eq(chatSessions.id, startingAfter), listedBy(scope)))
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

    // POST …/sessions — start a new conversation (of the mount's kind)
    create:
      (mount: SessionMount): SessionHandler =>
      async (c) => {
        const data = await readJsonBody(c, createSessionSchema, { allowEmpty: true });
        const scope = await mount.scope(c);
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

    // GET …/sessions/:id — the conversation's messages, in seq order (history load)
    get:
      (mount: SessionMount): SessionHandler =>
      async (c) => {
        const session = await getOwnedSession(c.req.param("id")!, await mount.scope(c));
        const [dto] = await toSessionDtos([session]);
        const messages = await loadMessages(session.id);
        return c.json({ ...dto, messages: messages.map(toMessageDto) });
      },

    // PATCH …/sessions/:id — rename
    rename:
      (mount: SessionMount): SessionHandler =>
      async (c) => {
        const session = await getOwnedSession(c.req.param("id")!, await mount.scope(c));
        const { title } = await readJsonBody(c, renameSessionSchema);
        await db
          .update(chatSessions)
          .set({ title, updatedAt: new Date() })
          .where(eq(chatSessions.id, session.id));
        notifySessionUpdate(session.id, session.orgId, session.userId);
        return c.body(null, 204);
      },

    // PUT …/sessions/:id/read — mark the session read (idempotent).
    // Advances the read marker up to the latest known watermark, monotonically
    // (GREATEST) so a late/replayed call can never regress it — and deliberately
    // NOT `updatedAt`, so opening a conversation never reorders the sidebar.
    // Mirrors PUT /notifications/:id/read. The SSE signal syncs the cleared
    // badge to the owner's other devices instantly.
    markRead:
      (mount: SessionMount): SessionHandler =>
      async (c) => {
        const session = await getOwnedSession(c.req.param("id")!, await mount.scope(c));
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
    remove:
      (mount: SessionMount): SessionHandler =>
      async (c) => {
        const session = await getOwnedSession(c.req.param("id")!, await mount.scope(c));
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
      },

    // GET …/sessions/:id/stream — reconnect to the in-flight turn (resume).
    // The client's native AI-SDK reconnect (`useChat({ resume: true })`) calls this
    // on mount: when a turn is generating we replay its recorded bytes + live tail
    // (so a mid-inference reload continues exactly where it was); otherwise 204.
    resume:
      (mount: SessionMount): SessionHandler =>
      async (c) => {
        // A brand-new, not-yet-sent conversation has no row — nothing to resume.
        const session = await findOwnedSession(c.req.param("id")!, await mount.scope(c));
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
    stop:
      (mount: SessionMount): SessionHandler =>
      async (c) => {
        const session = await getOwnedSession(c.req.param("id")!, await mount.scope(c));
        if (session.activeStreamId) stopStream(session.activeStreamId);
        return c.body(null, 204);
      },
  };
}
