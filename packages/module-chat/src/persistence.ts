// SPDX-License-Identifier: Apache-2.0

/**
 * Server-authoritative chat persistence.
 *
 * Why server-side: persistence used to be 100% client-driven (assistant-ui's
 * `useExternalHistory` POSTed the user+assistant pair only AFTER a run completed,
 * in one debounced batch). Leaving the conversation mid-inference dropped BOTH
 * messages and they never reappeared. The server now writes each message as soon
 * as it is known — the user turn before inference starts, the assistant turn when
 * the stream finalizes (driven to completion independently of the client by the
 * resumable-stream producer) — so a disconnect can no longer lose data.
 *
 * Storage stays byte-compatible with assistant-ui's `ai-sdk/v6`
 * MessageFormatAdapter so the existing client history-adapter LOAD path keeps
 * working unchanged: `content` = the UIMessage WITHOUT its `id` (the id lives in
 * `message_id`). Ordering is `chat_messages.seq` and nothing else. The `format`
 * and `parent_id` columns were dropped by `0054` — a constant and a re-encoding
 * of that same `seq` order, neither of which any reader ever looked at; see the
 * `chatMessages` table doc. The message a new one FOLLOWS is still computed
 * here, because `deterministicMessageId` hashes it.
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { chatMessages, chatSessions } from "@appstrate/db/schema";
import { notFound } from "@appstrate/core/api-errors";
import { uiMessageText } from "./message-text.ts";
import { notifySessionUpdate } from "./realtime.ts";
import type { UIMessage } from "ai";

/**
 * The slice of the Drizzle client the writers below use — satisfied by `db` and
 * by an open transaction handle alike, so the same helpers serve the
 * autocommit callers and the one that must run inside a transaction
 * ({@link persistNotice}).
 */
type ChatDbClient = Pick<typeof db, "select" | "insert" | "update">;

/** Storage content = UIMessage minus its id (the id rides in `message_id`). */
function toContent(message: UIMessage): Record<string, unknown> {
  const { id: _id, ...rest } = message;
  return rest as Record<string, unknown>;
}

/**
 * A `chat_sessions` row still carrying `space_id IS NULL` — a session written
 * before chat became space-scoped, whose backfill has not run.
 *
 * Mapping it to the caller's current space would move someone's conversation
 * into a space it never belonged to, so the read refuses instead and names the
 * script that fixes it. Same doctrine as `UnmigratedOrgRoleError`
 * (`NO_TRANSITIONAL_CODE.md` §1): the retired form fails loudly, never falls
 * back. The core-side twin lives in `apps/api/src/services/files.ts` (the
 * platform reads `chat_sessions` too, and `module-chat` is optional, so it
 * cannot import this one); keep the two in step and delete both in the release
 * that retires the nullable column (RBAC spec §11, release N+1).
 */
export class UnmigratedChatSessionError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(
      `chat_sessions.space_id IS NULL for session '${sessionId}'; ` +
        `run scripts/migration/0008-org-viewer-to-guest.sql`,
    );
    this.name = "UnmigratedChatSessionError";
    this.sessionId = sessionId;
  }
}

/**
 * Narrow a session row's nullable `space_id` to the string every read needs.
 *
 * @throws UnmigratedChatSessionError when the backfill has not run.
 */
export function assertMigratedSession(row: { id: string; spaceId: string | null }): string {
  if (row.spaceId === null) throw new UnmigratedChatSessionError(row.id);
  return row.spaceId;
}

/**
 * Create the session row if it does not exist yet (idempotent). The client
 * creates sessions up front, but a lazy ensure here closes the orphan-session
 * window (a row with zero messages) and lets the stream route be the single
 * writer of record.
 */
export async function ensureSession(
  id: string,
  orgId: string,
  userId: string,
  spaceId: string,
): Promise<void> {
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
  const [row] = await db
    .insert(chatSessions)
    .values({ id, orgId, userId, spaceId, title: null })
    .onConflictDoUpdate({
      target: chatSessions.id,
      set: { id: sql`${chatSessions.id}` },
      setWhere: and(eq(chatSessions.orgId, orgId), eq(chatSessions.userId, userId)),
    })
    .returning({
      id: chatSessions.id,
      orgId: chatSessions.orgId,
      userId: chatSessions.userId,
      spaceId: chatSessions.spaceId,
    });
  if (!row || row.orgId !== orgId || row.userId !== userId) {
    throw notFound("Chat session not found");
  }
  // The space stays OUT of `setWhere` and is checked here instead: a row of the
  // caller's own that predates the backfill must produce the loud refusal, not
  // a "not found" that reads as someone else's id.
  if (assertMigratedSession(row) !== spaceId) {
    throw notFound("Chat session not found");
  }
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
 * no column stores it. The `parent_id` column that used to was dropped in
 * migration 0054: it re-encoded `seq`, which is what every reader sorts by. The
 * argument survives because it is what keeps a DERIVED id distinct across
 * turns; see `deterministicMessageId`.
 */
async function upsertMessage(
  client: ChatDbClient,
  sessionId: string,
  message: UIMessage,
  precedingMessageId: string | null,
): Promise<{ messageId: string; seq: number }> {
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
  const content = toContent(message) as typeof chatMessages.$inferInsert.content;
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
  return titleFromText(uiMessageText(message.parts));
}

/** A message's text as a title: trimmed to 60 chars (57 + ellipsis); null when empty. */
function titleFromText(text: string): string | null {
  if (!text) return null;
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
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
    const title = titleFromText(uiMessageText(content.parts));
    if (title !== null) return title;
  }
  return null;
}
