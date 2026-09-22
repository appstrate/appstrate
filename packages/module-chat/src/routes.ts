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
import { scopedNameRegex } from "@appstrate/core/validation";
import { UI_MESSAGE_STREAM_HEADERS } from "ai";
import { handleChatStream, type ChatEnv } from "./chat-stream.ts";
import { stopStream } from "./stop-registry.ts";
import { clearActiveStream, getResumableContext, STALE_MARKER_MIN_AGE_MS } from "./resumable.ts";
import { mintSessionId } from "./session-id.ts";
import { notifySessionUpdate } from "./realtime.ts";
import { logger } from "./logger.ts";
import { dispatchCallerContext, spaceScopedHeaders } from "./prompt.ts";
import { selfOrigin, forwardedHeaders } from "./self.ts";
import { ensureSession, loadSessionPins, setSessionSkills } from "./persistence.ts";
import {
  MAX_PINNED_SKILLS,
  PLATFORM_DEFAULT_SKILLS,
  byPackageId,
  skillDiscoverySchema,
  type ChatSkillEntry,
  type SkillHint,
} from "./skills.ts";
import type { ChatPlatformDeps } from "./platform-services.ts";

/** Page size for the session list — one row past this is fetched to derive `hasMore`. */
const SESSIONS_PAGE_SIZE = 100;

export const createSessionSchema = z.object({
  title: z.string().min(1).max(200).optional(),
});

export const renameSessionSchema = z.object({
  title: z.string().min(1).max(200),
});

/**
 * `PUT /api/chat/sessions/{id}/skills` — the whole selection, replaced.
 *
 * SHAPE is refused, REPETITION is not. An id that is not `@scope/name` cannot
 * name a package, so it is a bug on the sender's side and a 400; a duplicate is
 * two clicks on the same row and is deduped server-side (below, after parsing);
 * an id that is merely unknown is a pin the turn reports as unresolved, never a
 * 4xx. The cap is applied by Zod to the array AS SENT rather than to the
 * deduped set, so it is the JSON Schema the OpenAPI spec publishes — a sender
 * over the ceiling learns it from the contract instead of from a silent trim.
 */
export const sessionSkillsSchema = z.object({
  skill_discovery: skillDiscoverySchema,
  pinned_skills: z
    .array(
      z.string().regex(scopedNameRegex, { error: "Each skill id must be in @scope/name form" }),
    )
    .max(MAX_PINNED_SKILLS, { error: `At most ${MAX_PINNED_SKILLS} pinned skills` }),
});

/**
 * How many rows of the space's skill catalogue the picker is HANDED. It bounds
 * the response, not the work: `GET /api/packages/skills` is unpaginated, so the
 * whole catalogue is read and this slice is what crosses the wire. Worth having
 * anyway — the picker is a popover, not a browser, and a space with thousands
 * of skills must not turn one keystroke into a thousand-row payload. A real
 * bound on the read would be a `limit` on that listing route, which does not
 * have one.
 */
const SKILL_PICKER_LIMIT = 100;

type SessionRow = typeof chatSessions.$inferSelect;
type MessageRow = typeof chatMessages.$inferSelect;

/**
 * `pinnedSkills` is passed by the two routes that answer for ONE session (the
 * detail read and the create); the list route omits it deliberately, so a page
 * of 100 conversations stays one query instead of 101. The OpenAPI schema says
 * the same.
 */
function toSessionDto(row: SessionRow, pinnedSkills?: readonly string[]) {
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
    // How much of the space's skill catalogue this conversation indexes. Always
    // present: the picker renders the current mode, and there is no "unset".
    skill_discovery: row.skillDiscovery,
    ...(pinnedSkills ? { pinned_skills: [...pinnedSkills] } : {}),
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

/** The fields the picker reads off one `GET /api/packages/skills` row. */
interface SpaceSkillRow {
  id: string;
  name?: string;
  description?: string | null;
  version?: string | null;
}

/**
 * The JSON body of a dispatched platform read, or `null` for every way it can
 * fail to produce one — a refusal (403 without `skills:read`), an error status,
 * an unparseable body, or a dispatch that throws outright.
 *
 * One `null` for all of them ON PURPOSE. The caller is building an affordance,
 * not answering a question about authorization: a picker that shows fewer rows
 * is usable, a picker that 500s is not, and the refusal the user actually needs
 * to see is the one the turn reports when it tries to USE a skill.
 */
async function readJson<T>(send: () => Promise<Response>): Promise<T | null> {
  try {
    const res = await send();
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Every skill the picker may offer, in the order it shows them: the platform
 * defaults first, then the space's catalogue, each sorted by package id.
 *
 * TWO reads, because the two halves answer different questions and no single
 * platform endpoint answers both. The defaults are `unlisted` system packages —
 * off every catalogue by construction — so they are resolved BY EXACT ID
 * through `/api/me/context?skills=`, the same call the turn makes, which is why
 * the picker can never offer a default the prompt does not index. The space
 * half is the ordinary catalogue (`GET /api/packages/skills`), i.e. what is
 * ACTIVE here and listed.
 *
 * Both are dispatched in-process, so the caller's own RBAC decides: a caller
 * without `skills:read` gets an empty half from each (the context read answers
 * with empty skill fields, the listing 403s) and therefore `{ skills: [] }` —
 * never a 500 and never someone else's catalogue. A non-OK response is treated
 * as "nothing to offer" for the same reason: the picker is an affordance, and
 * degrading it to empty is strictly better than failing the whole popover.
 */
async function listChatSkills(
  c: Context<ChatEnv>,
  deps: ChatPlatformDeps,
): Promise<ChatSkillEntry[]> {
  const origin = selfOrigin();
  const headers = forwardedHeaders(c);
  const spaceId = c.get("space").id;

  const [platformRes, spaceRes] = await Promise.all([
    readJson<{ requested_skills?: SkillHint[] }>(() =>
      dispatchCallerContext(deps, { origin, headers, spaceId, skills: PLATFORM_DEFAULT_SKILLS }),
    ),
    readJson<{ data?: SpaceSkillRow[] }>(() =>
      deps.dispatch(
        new Request(new URL("/api/packages/skills", origin).toString(), {
          headers: spaceScopedHeaders(headers, spaceId),
        }),
      ),
    ),
  ]);

  const platform: ChatSkillEntry[] = (platformRes?.requested_skills ?? [])
    .map((hint) => ({
      package_id: hint.package_id,
      display_name: hint.display_name?.trim() || hint.package_id,
      description: hint.description?.trim() ?? "",
      version: hint.version ?? null,
      source: "platform" as const,
    }))
    .sort(byPackageId);

  // A default that is ALSO in the space catalogue stays on the platform half:
  // the chat indexes it whatever the space does, so offering it twice would let
  // the user "unpin" a row the turn keeps indexing.
  const platformIds = new Set(platform.map((entry) => entry.package_id));
  const space: ChatSkillEntry[] = (spaceRes?.data ?? [])
    .filter((item) => !platformIds.has(item.id))
    .map((item) => ({
      package_id: item.id,
      display_name: item.name?.trim() || item.id,
      description: item.description?.trim() ?? "",
      version: item.version ?? null,
      source: "space" as const,
    }))
    .sort(byPackageId)
    .slice(0, SKILL_PICKER_LIMIT);

  return [...platform, ...space];
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
    return c.json({ object: "list", data: page.map((row) => toSessionDto(row)), hasMore });
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
      // A brand-new conversation has no pins; the field is present so the
      // client never has to distinguish "none" from "not loaded".
      return c.json(toSessionDto(row!, []), 201);
    },
  );

  // GET /api/chat/sessions/:id — the conversation's messages, in seq order (history load)
  router.get("/api/chat/sessions/:id", requireModulePermission("chat", "read"), async (c) => {
    const session = await getOwnedSession(c.req.param("id"), sessionScope(c));
    const [messages, pins] = await Promise.all([
      loadMessages(session.id),
      loadSessionPins(session.id),
    ]);
    return c.json({ ...toSessionDto(session, pins), messages: messages.map(toMessageDto) });
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

  // GET /api/chat/skills — what the skill picker and the `/` popover offer.
  // A read of two catalogues, so `chat:read` plus whatever the two dispatched
  // reads ask for on their own (`skills:read`); see `listChatSkills`. Rate
  // limited like the PUT next to it: one call fans out into two unpaginated
  // platform reads, and the `/` popover can fire it on a keystroke.
  router.get(
    "/api/chat/skills",
    rateLimited(60),
    requireModulePermission("chat", "read"),
    async (c) => {
      return c.json({ skills: await listChatSkills(c, deps) });
    },
  );

  // PUT /api/chat/sessions/:id/skills — replace the conversation's skill
  // selection (discovery mode + pins).
  //
  // `ensureSession` FIRST, and that is the whole reason this is a PUT on a
  // possibly-nonexistent id: the client mints the session id and creates the
  // conversation lazily, so pinning a skill before sending the first message is
  // the normal case. Creating the row here is exactly what the first turn would
  // have done — same ownership check, same 404 on a foreign-tenant id.
  router.put(
    "/api/chat/sessions/:id/skills",
    rateLimited(60),
    requireModulePermission("chat", "write"),
    async (c) => {
      const scope = sessionScope(c);
      const id = c.req.param("id");
      const data = parseBody(sessionSkillsSchema, await c.req.json().catch(() => null));
      await ensureSession(id, scope.orgId, scope.userId, scope.spaceId);
      await setSessionSkills(id, {
        discovery: data.skill_discovery,
        // Deduped and sorted here, so the stored set is the one the prompt
        // renders and `loadSessionPins` reads back unchanged.
        pinned: [...new Set(data.pinned_skills)].sort(),
      });
      notifySessionUpdate(id, scope.orgId, scope.userId);
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
