// SPDX-License-Identifier: Apache-2.0

/**
 * Server-authoritative chat persistence.
 *
 * Write the user turn before inference and the assistant turn when the stream
 * finalizes on the server, so a client disconnect cannot lose either turn.
 * The message payload preserves the UIMessage and seq orders the conversation.
 * deterministicMessageId uses the predecessor to identify a retried append.
 */

import { and, desc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { isForeignKeyViolation } from "@appstrate/db/errors";
import { db } from "@appstrate/db/client";
import {
  chatMessages,
  chatSessions,
  chatSessionSpaces,
  chatSkillStatusValues,
  files,
  type ChatMessageContent,
} from "@appstrate/db/schema";
import { toPgSafe } from "@appstrate/db/pg-safe";
import { invalidRequest, notFound } from "@appstrate/core/api-errors";
import { uiMessageTitleText } from "./message-text.ts";
import { AGENT_PROMPT_PART_TYPE } from "@appstrate/core/chat-message";
import { agentPromptOfParts } from "./agent-prompt.ts";
import { notifySessionUpdate } from "./realtime.ts";
import type { ChatSkillSelection, PinnedSkill, SkillSettingsPatch } from "./skills.ts";
import type { FileUIPart, UIMessage } from "ai";

/**
 * The slice of the Drizzle client the writers below use — satisfied by `db` and
 * by an open transaction handle alike, so the same helpers serve the
 * autocommit callers and the one that must run inside a transaction
 * ({@link persistNotice}).
 */
type ChatDbClient = Pick<typeof db, "select" | "insert" | "update">;

/** Storage content = UIMessage minus its id (the id rides in `message_id`). */
function toContent(message: UIMessage): ChatMessageContent {
  const { id: _id, ...rest } = message;
  return rest;
}

/**
 * The touched set T of the outer `chat_sessions` row, as `(space_id, touched_at)` rows: its
 * origin space (first), then each `chat_session_spaces` row by touch time. The one
 * definition behind the list filter, the visibility rule and the DTO's `space_ids`.
 */
const touchedSpaces = sql`(
  SELECT ${chatSessions.spaceId} AS space_id, '-infinity'::timestamptz AS touched_at
    WHERE ${chatSessions.spaceId} IS NOT NULL
  UNION ALL
  SELECT ${chatSessionSpaces.spaceId}, ${chatSessionSpaces.createdAt}
    FROM ${chatSessionSpaces} WHERE ${chatSessionSpaces.sessionId} = ${chatSessions.id}
)`;

/**
 * A conversation is visible while every space of its touched set is readable: none outside
 * `readable`. One predicate for the open, the list and the turn, so none can drift from the
 * others.
 */
export function sessionVisible(readable: readonly string[]): SQL {
  const unreadable =
    readable.length === 0
      ? sql`true`
      : sql`touched.space_id NOT IN (${sql.join(
          readable.map((id) => sql`${id}`),
          sql`, `,
        )})`;
  return sql`NOT EXISTS (SELECT 1 FROM ${touchedSpaces} AS touched WHERE ${unreadable})`;
}

/**
 * The conversations a space filter lists: those whose touched set holds `spaceId`, and
 * those whose set is empty — one that holds no space's data belongs to every filter until
 * its first act decides.
 */
export function touchedUnder(spaceId: string): SQL {
  return sql`(EXISTS (SELECT 1 FROM ${touchedSpaces} AS touched WHERE touched.space_id = ${spaceId})
    OR NOT EXISTS (SELECT 1 FROM ${touchedSpaces} AS touched))`;
}

/** The touched set of each of `sessionIds`: origin space first, then by touch time. */
export async function touchedSpaceIds(
  sessionIds: readonly string[],
): Promise<Map<string, string[]>> {
  const touched = new Map<string, string[]>();
  if (sessionIds.length === 0) return touched;
  const rows = await db
    .select({ sessionId: chatSessions.id, spaceId: sql<string>`touched.space_id` })
    .from(chatSessions)
    .innerJoin(sql`LATERAL ${touchedSpaces} AS touched`, sql`true`)
    .where(inArray(chatSessions.id, [...sessionIds]))
    .orderBy(sql`touched.touched_at`, sql`touched.space_id`);
  for (const { sessionId, spaceId } of rows) {
    touched.set(sessionId, [...(touched.get(sessionId) ?? []), spaceId]);
  }
  return touched;
}

/**
 * Record that a conversation acted in each of `spaceIds`, BEFORE the act is dispatched: it is then
 * listed and opened only while its author reaches those spaces too. Its origin space is touched
 * by definition and recorded nowhere else. One insert for all of them; the session list is told
 * once, when the record grew, so its space line refreshes.
 */
export async function touchSessionSpaces(
  session: { id: string; orgId: string; userId: string; originSpaceId: string | null },
  spaceIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(spaceIds)].filter((id) => id !== session.originSpaceId);
  if (ids.length === 0) return;
  const inserted = await db
    .insert(chatSessionSpaces)
    .values(ids.map((spaceId) => ({ sessionId: session.id, spaceId, orgId: session.orgId })))
    .onConflictDoNothing()
    .returning({ spaceId: chatSessionSpaces.spaceId });
  if (inserted.length > 0) notifySessionUpdate(session.id, session.orgId, session.userId);
}

/** {@link touchSessionSpaces} for one space. */
export const touchSessionSpace = (
  session: Parameters<typeof touchSessionSpaces>[0],
  spaceId: string,
): Promise<void> => touchSessionSpaces(session, [spaceId]);

/**
 * Runs a write that sets a conversation's origin space, checked in the acting set before it:
 * the space deleted in between refuses the write on its foreign key, answered as the same 400
 * naming `spaceId` the check gives.
 */
export async function writingOriginSpace<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (!isForeignKeyViolation(error, "chat_sessions_space_id_org_id_fk")) throw error;
    throw invalidRequest("spaceId must be a space this conversation can act in", "spaceId");
  }
}

/** Create a conversation with its origin space and limit (`restricted` needs the space). */
export async function createSession(input: {
  id: string;
  orgId: string;
  userId: string;
  title: string | null;
  spaceId: string | null;
  restricted: boolean;
}): Promise<typeof chatSessions.$inferSelect> {
  const insert = async () => (await db.insert(chatSessions).values(input).returning())[0]!;
  return input.spaceId === null ? insert() : writingOriginSpace(insert);
}

/**
 * The space of the file `fileId` names in `orgId`, undefined for a missing file and for one the
 * conversation holds in the caller's personal space: that one is reached through its container,
 * not a space. A file the conversation holds in any other space names that space.
 */
export async function fileSpaceId(
  orgId: string,
  fileId: string,
  conversation: { chatSessionId: string | null; personalSpaceId: string | null },
): Promise<string | undefined> {
  const { chatSessionId, personalSpaceId } = conversation;
  const [row] = await db
    .select({ spaceId: files.spaceId })
    .from(files)
    .where(
      and(
        eq(files.id, fileId),
        eq(files.orgId, orgId),
        chatSessionId && personalSpaceId
          ? or(
              isNull(files.chatSessionId),
              ne(files.chatSessionId, chatSessionId),
              ne(files.spaceId, personalSpaceId),
            )
          : undefined,
      ),
    )
    .limit(1);
  return row?.spaceId;
}

/** What a turn takes from the conversation row: its skill selection, origin space and limit. */
export interface TurnConversation {
  selection: ChatSkillSelection;
  spaceId: string | null;
  restricted: boolean;
  /** Its touched set: origin first, then by touch time (see {@link touchedSpaceIds}). */
  touched: string[];
}

/** The origin space and limit a conversation is created with; throws the 400 for an invalid one. */
type ConversationOriginRequest = () => { spaceId: string; restricted: boolean } | undefined;

/**
 * Create the session row if it does not exist yet (idempotent). The client mints the id. The
 * `selection` (the composer's buffered skill settings) is written only by the insert: an
 * existing conversation keeps its own, changed by the skills PATCH alone. The
 * `origin` request (origin space and limit) is called ONLY when this call creates the row:
 * an existing conversation keeps its own and the request is never evaluated. A turn naming an
 * origin runs in a transaction that evaluates it once the row is known to be new (a refusal
 * rolls the row back); a turn naming none is a single statement. Returns what the turn takes
 * from the row.
 */
export async function ensureSession(
  id: string,
  orgId: string,
  userId: string,
  /**
   * The spaces its author still reads: an existing session opens only while every
   * space it touched is among them.
   */
  readable: readonly string[],
  selection?: Partial<ChatSkillSelection>,
  origin?: ConversationOriginRequest,
): Promise<TurnConversation> {
  // The id is client-minted, so a caller could send an id that already belongs
  // to another tenant; a plain `DO NOTHING` would leave that row intact and we'd
  // then persist a message into it. `DO UPDATE … SET id = id` is a no-op write
  // that still makes the conflicting row visible to `RETURNING`, so the insert
  // and the ownership check are ONE round trip instead of two — this sits on the
  // pre-inference path of every turn.
  //
  // `setWhere` is what keeps that round trip from writing into a row the caller
  // does not own. Without it the UPDATE ran FIRST and the ownership check
  // followed in application code, so a REFUSED cross-tenant request still
  // produced a new heap tuple, WAL, both index entries and a row-exclusive lock
  // on the victim's row. Harmless only for as long as no column value changes:
  // the day `updatedAt` gains an `$onUpdateFn` — the obvious thing to do on this
  // table — drizzle folds it into the SET clause automatically and a 404 starts
  // silently re-sorting a stranger's sidebar. With the predicate, a foreign
  // conflict updates zero rows, `RETURNING` yields nothing, and the `!row` arm
  // below already says 404. One round trip AND no write.
  //
  // 404, not 403, so we don't reveal that the id exists for someone else.
  const upsert = (client: ChatDbClient) =>
    client
      .insert(chatSessions)
      .values({ id, orgId, userId, title: null, ...selection })
      .onConflictDoUpdate({
        target: chatSessions.id,
        set: { id: sql`${chatSessions.id}` },
        setWhere: and(
          eq(chatSessions.orgId, orgId),
          eq(chatSessions.userId, userId),
          sessionVisible(readable),
        ),
      })
      .returning({
        orgId: chatSessions.orgId,
        userId: chatSessions.userId,
        skillDiscovery: chatSessions.skillDiscovery,
        pinnedSkills: chatSessions.pinnedSkills,
        spaceId: chatSessions.spaceId,
        restricted: chatSessions.restricted,
        // Read in the same round trip: the turn renders what these spaces hold.
        touched: sql<string[]>`ARRAY(SELECT touched.space_id FROM ${touchedSpaces} AS touched
          ORDER BY touched.touched_at, touched.space_id)`,
        // `xmax` is 0 on a freshly inserted tuple and set on one the conflict arm rewrote.
        created: sql<boolean>`(xmax = 0)`,
      });
  const row = origin
    ? await writingOriginSpace(() =>
        db.transaction(async (tx) => {
          const [inserted] = await upsert(tx);
          if (!inserted?.created) return inserted;
          const created = origin();
          if (!created) return inserted;
          await tx.update(chatSessions).set(created).where(eq(chatSessions.id, id));
          return { ...inserted, ...created };
        }),
      )
    : (await upsert(db))[0];
  if (!row || row.orgId !== orgId || row.userId !== userId) {
    throw notFound("Chat session not found");
  }
  return {
    selection: { skillDiscovery: row.skillDiscovery, pinnedSkills: row.pinnedSkills },
    spaceId: row.spaceId,
    restricted: row.restricted,
    touched: row.touched,
  };
}

/**
 * Write a session's skill settings (the skills PATCH): `pinnedSkills` replaces the set, dropping
 * the `skill_status` of every skill it no longer holds (a new pin has none until a turn evaluates
 * it). Leaves `updated_at`, so a pin never reorders the sidebar. A turn in flight keeps what it
 * read; the next one reads this. Returns the row, or undefined when it is gone.
 */
export async function updateSessionSkills(
  session: SQL,
  change: SkillSettingsPatch,
): Promise<typeof chatSessions.$inferSelect | undefined> {
  const { pin, pins } = change;
  // PostgreSQL evaluates the update against the latest locked row, including another tab's
  // committed pin changes. "C" matches the JS sort order of the ASCII package ids.
  const pinUpdate = pin?.pinned
    ? {
        pinnedSkills: sql`ARRAY(SELECT DISTINCT id COLLATE "C" FROM unnest(array_append(${chatSessions.pinnedSkills}, ${pin.id}::text)) AS ids(id) ORDER BY 1)`,
      }
    : pin
      ? {
          pinnedSkills: sql`array_remove(${chatSessions.pinnedSkills}, ${pin.id}::text)`,
          skillStatus: sql`${chatSessions.skillStatus} - ${pin.id}::text`,
        }
      : undefined;
  const [row] = await db
    .update(chatSessions)
    .set({
      skillDiscovery: change.skill_discovery,
      ...pinUpdate,
      ...(pins !== undefined && {
        pinnedSkills: pins,
        skillStatus: sql`(SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb) FROM jsonb_each(${chatSessions.skillStatus}) WHERE key IN (SELECT jsonb_array_elements_text(${JSON.stringify(pins)}::jsonb)))`,
      }),
    })
    .where(session)
    .returning();
  return row;
}

const skillStatusEntrySchema = z.object({
  status: z.enum(chatSkillStatusValues),
  chars: z.int().nonnegative().nullable().catch(null),
});

/**
 * The pins of a session row as its DTOs carry them (`pins`); every write stores them sorted.
 * `skill_status` is jsonb, which no CHECK holds to the contract: an entry off it reads as not
 * evaluated (`null`), a `chars` that is not a non-negative integer as `null`. Here, not in
 * `skills.ts`: the narrowing needs the values at run time, which the browser-safe `skills.ts`
 * cannot import from `@appstrate/db/schema`.
 */
export function pinnedSkillsOf(row: {
  pinnedSkills: readonly string[];
  skillStatus: Readonly<Record<string, unknown>>;
}): PinnedSkill[] {
  return row.pinnedSkills.map((id) => {
    const entry = skillStatusEntrySchema.safeParse(row.skillStatus[id]);
    return entry.success ? { id, ...entry.data } : { id, status: null, chars: null };
  });
}

/** Most recent message id in a session — the one a new message follows, or null. */
async function lastMessageId(client: ChatDbClient, sessionId: string): Promise<string | null> {
  const [row] = await client
    .select({ messageId: chatMessages.messageId })
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(desc(chatMessages.seq))
    .limit(1);
  return row?.messageId ?? null;
}

/**
 * Deterministic message id for a UIMessage that arrives without one. Derived
 * from (sessionId, precedingMessageId, content) so it is:
 *   - STABLE across retries of the same finalize — a retried assistant persist
 *     produces the same id, so the upsert dedupes on the conflict target
 *     instead of inserting a fresh row every attempt (duplicate messages).
 *   - DISTINCT across turns — a different predecessor/content hashes
 *     differently, preserving the earlier fix where an empty id collided across
 *     turns.
 */
async function deterministicMessageId(
  sessionId: string,
  precedingMessageId: string | null,
  content: unknown,
): Promise<string> {
  const material = `${sessionId}\u0000${precedingMessageId ?? ""}\u0000${JSON.stringify(content)}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `gen_${hex.slice(0, 32)}`;
}

/**
 * The single write path into `chat_messages`.
 *
 * `precedingMessageId` — the message this one follows — is HASH MATERIAL only;
 * no column stores it: a column would re-encode `seq`, which is what every reader
 * sorts by. The argument is what keeps a DERIVED id distinct across
 * turns; see `deterministicMessageId`.
 */
async function upsertMessage(
  client: ChatDbClient,
  sessionId: string,
  rawMessage: UIMessage,
  precedingMessageId: string | null,
): Promise<{ messageId: string; seq: number }> {
  // A NUL (tool/MCP output, model delta) makes Postgres refuse the row: the message is lost.
  const message = toPgSafe(rawMessage);
  // Why the hash material cannot be trimmed now that no column stores it: every
  // `gen_…` id already in the table was derived WITH `precedingMessageId`, so
  // dropping it from the material would mint a different id for the same
  // message and break this upsert's dedupe on a retried finalize.
  //
  // The row is keyed by (sessionId, messageId). The assistant UIMessage parsed
  // from the stream can arrive WITHOUT an id (the engine's start chunk may omit
  // `messageId`); an empty id would collide across turns and silently overwrite
  // an earlier message (e.g. the OAuth-card turn vanishing after a resume). A
  // *random* fallback id would instead break idempotency — a retried finalize
  // would mint a new id each attempt and insert a duplicate row — so derive a
  // stable, content-addressed id when one is missing.
  const content = toContent(message);
  const messageId =
    message.id || (await deterministicMessageId(sessionId, precedingMessageId, content));
  // `seq` feeds the read-state watermark. On a retried finalize the conflict
  // UPDATE returns the EXISTING row's seq, so the watermark stays idempotent.
  const [row] = await client
    .insert(chatMessages)
    .values({ sessionId, messageId, content })
    .onConflictDoUpdate({
      target: [chatMessages.sessionId, chatMessages.messageId],
      set: { content },
    })
    .returning({ seq: chatMessages.seq });
  return { messageId, seq: row!.seq };
}

/**
 * What the session's stored messages among `messageIds` carry, by message id: the file parts an
 * earlier turn attached, as the server materialized them, and the resolved launch text of an
 * agent launch (`agent-prompt.ts`), the one source of an earlier message's launch text.
 */
export async function storedHistory(
  sessionId: string,
  messageIds: readonly string[],
): Promise<{ files: Map<string, FileUIPart[]>; launches: Map<string, string> }> {
  const files = new Map<string, FileUIPart[]>();
  const launches = new Map<string, string>();
  if (!messageIds.length) return { files, launches };
  const rows = await db
    .select({ messageId: chatMessages.messageId, content: chatMessages.content })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.sessionId, sessionId),
        inArray(chatMessages.messageId, [...messageIds]),
        sql`(${chatMessages.content}->'parts' @> '[{"type":"file"}]'::jsonb OR ${chatMessages.content}->'parts' @> ${JSON.stringify([{ type: AGENT_PROMPT_PART_TYPE }])}::jsonb)`,
      ),
    );
  for (const row of rows) {
    const fileParts = row.content.parts.filter(
      (part): part is FileUIPart => (part as { type?: unknown }).type === "file",
    );
    if (fileParts.length) files.set(row.messageId, fileParts);
    const text = agentPromptOfParts(row.content.parts)?.data.text;
    if (text) launches.set(row.messageId, text);
  }
  return { files, launches };
}

/**
 * Persist the user turn BEFORE inference starts. Returns the user message id so
 * the assistant turn can derive its own id from it.
 *
 * The message this one follows is read ONLY when the message carries no id. It
 * is hash material for `deterministicMessageId`, which `upsertMessage` reaches
 * on that branch alone; the chat route always sends the client-minted id, so
 * the common turn is one INSERT and one UPDATE with no read in front of them.
 * The derived-id path is unchanged: same material, same id.
 *
 * `client` is the writer's DB slice — `db` in production. A caller that needs
 * to observe the statements this issues (a test counting round trips) passes
 * its own.
 */
export async function persistUserMessage(
  sessionId: string,
  message: UIMessage,
  client: ChatDbClient = db,
): Promise<string> {
  const precedingMessageId = message.id ? null : await lastMessageId(client, sessionId);
  const { messageId, seq } = await upsertMessage(client, sessionId, message, precedingMessageId);
  const owner = await touchSession(client, sessionId, "user", seq, titleCandidate(message));
  if (owner) notifySessionUpdate(sessionId, owner.orgId, owner.userId);
  return messageId;
}

/**
 * Persist the turn's assistant message when the stream finalizes.
 * `precedingMessageId` is the user turn that prompted it — hash material for a
 * derived id when the stream carried none (see `upsertMessage`).
 */
export async function persistAssistantMessage(
  sessionId: string,
  message: UIMessage,
  precedingMessageId: string | null,
): Promise<void> {
  const { seq } = await upsertMessage(db, sessionId, message, precedingMessageId);
  const owner = await touchSession(db, sessionId, "assistant", seq);
  if (owner) notifySessionUpdate(sessionId, owner.orgId, owner.userId);
}

/**
 * Persist a SERVER-AUTHORED notice into a session, chained onto its last
 * message — the only way anything other than a live turn writes into a
 * conversation (C3: a run whose launching turn is already dead announcing its
 * deliverables).
 *
 * Goes through the same single writer as every other message (`upsertMessage` →
 * `touchSession`), so ordering, the title derivation and the unread watermark
 * behave identically. Persisted with the ASSISTANT role
 * (not `system`): the engine's history projection (`buildStructuredPiTurn`)
 * keeps only `user` and `assistant` — a mid-transcript system message would be
 * dropped on the next turn, and refused outright by `chatStreamSchema` on the
 * way back in — and the notice reads naturally as something the assistant says.
 *
 * `messageId` is CALLER-CHOSEN and must be derived from the event, not random:
 * an already-present id makes this a no-op (returns false) so a replayed
 * reconciliation cannot append a second copy. The early return — rather than
 * relying on the `(session_id, message_id)` upsert — is what makes the replay
 * cost nothing.
 *
 * What the early return saves is a write, not a wrong read-state. Read-state
 * would survive the upsert untouched: the conflict path returns the EXISTING
 * row's `seq`, and `touchSession` advances `lastAssistantSeq` by
 * `GREATEST(coalesce(lastAssistantSeq, 0), seq)` — already ≥ that `seq` since
 * the first write set it — while `lastReadSeq` is not in the assistant branch
 * at all, so `unread` cannot flip. What the upsert WOULD do is rewrite the row
 * (a fresh heap tuple carrying identical content) and re-run `touchSession` on
 * it: an UPDATE of `chat_sessions` bumping `updatedAt` (plus a title scan for
 * as long as `title` is null) — which re-sorts the conversation list, ordered
 * `desc(updatedAt)` in routes.ts — and an SSE `notifySessionUpdate` telling
 * every connected client of that owner to refetch. A replayed reconciliation
 * would jump the session to the top of its owner's sidebar with nothing new in
 * it.
 *
 * THE SINGLE-WRITER GUARD IS HERE, not in the caller. A notice may only be
 * written while no turn is generating (`active_stream_id IS NULL`) — a turn
 * owns the conversation for its whole life, and a notice slipped in beside it
 * takes a `seq` in the middle of that turn, bumps `lastAssistantSeq` and marks
 * a session unread that its owner is actively watching. The caller used to read
 * that column itself and then call this function, which is a read-then-write:
 * `setActiveStream` could start a turn in the gap. The check now runs inside
 * the same transaction as the insert, behind `SELECT … FOR UPDATE` on the
 * session row — the same serialization point `cleanupSessionFiles` uses — so
 * either this notice commits before the turn starts, or the turn wins and
 * `active_stream_id` is no longer null when the lock is granted (Postgres
 * re-checks the predicate against the updated row). Returns false in the
 * second case, exactly as if the turn had started first.
 */
export async function persistNotice(input: {
  sessionId: string;
  /** Tenant scope — the session must belong to it, as every chat query does. */
  orgId: string;
  messageId: string;
  text: string;
}): Promise<boolean> {
  const { sessionId, orgId, messageId, text } = input;
  // The owner is carried OUT of the transaction so the change signal can be
  // emitted after it commits. `notifySessionUpdate` issues its `pg_notify` on
  // the pooled `db`, never on `tx` — a different connection, which autocommits
  // at once. Emitted from inside this transaction the signal reached the SSE
  // fan-out BEFORE the notice row committed: every connected client of that
  // owner refetched the conversation and got a transcript without the notice
  // in it, then sat on it until the next unrelated signal.
  const { posted, owner } = await db.transaction(async (tx): Promise<NoticeOutcome> => {
    const [idle] = await tx
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.id, sessionId),
          eq(chatSessions.orgId, orgId),
          isNull(chatSessions.activeStreamId),
        ),
      )
      .limit(1)
      .for("update");
    // No row = the session is gone, is another tenant's, or a turn owns it.
    // Either way: not ours to write into.
    if (!idle) return { posted: false, owner: null };
    const [existing] = await tx
      .select({ seq: chatMessages.seq })
      .from(chatMessages)
      .where(and(eq(chatMessages.sessionId, sessionId), eq(chatMessages.messageId, messageId)))
      .limit(1);
    if (existing) return { posted: false, owner: null };
    const message = {
      id: messageId,
      role: "assistant",
      parts: [{ type: "text", text }],
    } as UIMessage;
    // `null`, not `await lastMessageId(tx, …)`. `precedingMessageId` is hash
    // material for `deterministicMessageId`, which `upsertMessage` reaches only
    // when `message.id` is falsy — and a notice's id is always the caller's own
    // (`run_notice_<runId>`, the single call site), so that branch is
    // unreachable here. The read it replaced was pure cost in the worst place
    // for one: a `chat_messages` scan held while this transaction has the
    // session row locked `FOR UPDATE`, which is the serialization point a
    // starting turn contends on.
    const { seq } = await upsertMessage(tx, sessionId, message, null);
    return { posted: true, owner: await touchSession(tx, sessionId, "assistant", seq) };
  });
  if (owner) notifySessionUpdate(sessionId, owner.orgId, owner.userId);
  return posted;
}

/** Tenant + owner of a session — the fan-out key `notifySessionUpdate` needs. */
interface SessionOwner {
  orgId: string;
  userId: string;
}

/** What {@link persistNotice}'s transaction hands back to its caller. */
interface NoticeOutcome {
  posted: boolean;
  owner: SessionOwner | null;
}

/**
 * Bump `updatedAt`, set the title if still unset, and advance the read-state
 * watermark matching the persisted turn: an assistant turn advances
 * `lastAssistantSeq` (the session becomes unread until its owner looks at it),
 * a user turn advances `lastReadSeq` (sending a message implies having seen the
 * thread — keeps headless/API senders from accruing phantom unread). Watermarks
 * are message pointers, monotonic via GREATEST — a replayed/late write can
 * never regress them.
 *
 * ONE statement on the common path: the title is written as `COALESCE(title, <candidate>)`, where the candidate is the
 * text of the message being persisted (a user turn; see `titleCandidate`), so
 * a first user message titles the session in the same UPDATE that records it,
 * and a later one can never overwrite a title that is already there — the
 * user's own rename included. `RETURNING` hands back the owner the caller
 * signals with, and the title as it stands after the write.
 *
 * The scan (`deriveTitle`) survives as a fallback for the one case the
 * candidate cannot cover: the row is still untitled after the write AND this
 * message brought no candidate — an assistant turn or a server notice on a
 * session whose user turns carried no text. Then, and only then, the earlier
 * user messages are read and a second, guarded UPDATE sets whatever they
 * yield.
 *
 * Returns the session's owner (null when the row is gone) INSTEAD of signalling
 * the change itself. `notifySessionUpdate` always publishes on the pooled `db`,
 * so a signal raised here while `client` is a transaction handle leaves on a
 * different connection and autocommits before the write it announces — the SSE
 * fan-out fires, the client refetches, and the row is not visible yet. Each
 * caller signals once its own write is committed; for the autocommit callers
 * that is the very next statement, for `persistNotice` it is after
 * `db.transaction` returns.
 */
async function touchSession(
  client: ChatDbClient,
  sessionId: string,
  kind: "user" | "assistant",
  seq: number,
  candidate: string | null = null,
): Promise<SessionOwner | null> {
  const [session] = await client
    .update(chatSessions)
    .set({
      updatedAt: new Date(),
      ...(kind === "assistant"
        ? { lastAssistantSeq: sql`GREATEST(coalesce(${chatSessions.lastAssistantSeq}, 0), ${seq})` }
        : { lastReadSeq: sql`GREATEST(coalesce(${chatSessions.lastReadSeq}, 0), ${seq})` }),
      // The cast pins the parameter's type when the candidate is null.
      title: sql`COALESCE(${chatSessions.title}, ${candidate}::text)`,
    })
    .where(eq(chatSessions.id, sessionId))
    .returning({
      title: chatSessions.title,
      orgId: chatSessions.orgId,
      userId: chatSessions.userId,
    });
  if (!session) return null;
  if (session.title === null && candidate === null) {
    const derived = await deriveTitle(client, sessionId);
    if (derived !== null) {
      // Guarded like the COALESCE above: a title set in between stays.
      await client
        .update(chatSessions)
        .set({ title: derived })
        .where(and(eq(chatSessions.id, sessionId), isNull(chatSessions.title)));
    }
  }
  return { orgId: session.orgId, userId: session.userId };
}

/**
 * The title a message being persisted proposes for its session: a user turn's
 * text, or nothing — an assistant turn never titles a conversation. Computed
 * in memory from the message already in hand, so the common first turn needs
 * no scan of `chat_messages`. Same rule as `deriveTitle`, which reads the
 * stored form of the same messages.
 */
function titleCandidate(message: UIMessage): string | null {
  if (message.role !== "user") return null;
  return titleFromText(uiMessageTitleText(message.parts));
}

const TITLE_HEAD = 57;

/**
 * A message's text as a title, opening on a capital (not a brand-style lowercase such as
 * "iPhone"); null when empty. Past 60 chars it is cut to its head plus an ellipsis — on the last
 * word boundary, unless that sits before char 30 (a short word, then a long unbroken token),
 * where the word is cut. `toUpperCase`, not the locale's: the server's locale must not decide a
 * title.
 */
export function titleFromText(raw: string): string | null {
  if (!raw) return null;
  const text = raw.replace(/^\p{Ll}(?!\p{Lu})/u, (c) => c.toUpperCase());
  if (text.length <= 60) return toPgSafe(text);
  const head = text.slice(0, TITLE_HEAD);
  const midWord = /\S/.test(text.charAt(TITLE_HEAD)) && /\S$/.test(head);
  const boundary = head.search(/\s+\S*$/);
  const kept = midWord && boundary >= 30 ? head.slice(0, boundary) : head.trimEnd();
  // `chat_sessions.title` is text: a NUL would fail the turn's session UPDATE.
  return toPgSafe(`${kept}…`);
}

/**
 * How many of a session's earliest USER messages to inspect for a title.
 *
 * The loop below skips a user message with no text (one carrying only an
 * attachment, say), so this cannot be 1. Ten is far past the point
 * where a conversation that has not yielded a title is going to.
 */
const TITLE_SCAN_LIMIT = 10;

/**
 * First user message's text as a title (see `titleFromText`), read back from
 * storage. The fallback path of `touchSession` — the common path titles from
 * the message in hand without a read.
 */
async function deriveTitle(client: ChatDbClient, sessionId: string): Promise<string | null> {
  const rows = await client
    .select({ content: chatMessages.content })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.sessionId, sessionId),
        // Role lives inside the jsonb payload; filtering here rather than in the
        // loop is what keeps the scan off the assistant turns, which are both
        // the majority of rows and the largest (tool calls and results).
        sql`${chatMessages.content}->>'role' = 'user'`,
      ),
    )
    .orderBy(chatMessages.seq)
    .limit(TITLE_SCAN_LIMIT);
  for (const row of rows) {
    const content = row.content as { role?: string; parts?: unknown[] };
    if (content?.role !== "user" || !Array.isArray(content.parts)) continue;
    const title = titleFromText(uiMessageTitleText(content.parts));
    if (title !== null) return title;
  }
  return null;
}
