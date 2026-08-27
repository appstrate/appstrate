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
 * `message_id`). Ordering is `chat_messages.seq` and nothing else.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { chatMessages, chatSessions } from "@appstrate/db/schema";
import { notFound } from "@appstrate/core/api-errors";
import { uiMessageText } from "./message-text.ts";
import { notifySessionUpdate } from "./realtime.ts";
import type { UIMessage } from "ai";

/** Storage content = UIMessage minus its id (the id rides in `message_id`). */
function toContent(message: UIMessage): Record<string, unknown> {
  const { id: _id, ...rest } = message;
  return rest as Record<string, unknown>;
}

/**
 * Create the session row if it does not exist yet (idempotent). The client
 * creates sessions up front, but a lazy ensure here closes the orphan-session
 * window (a row with zero messages) and lets the stream route be the single
 * writer of record.
 */
export async function ensureSession(id: string, orgId: string, userId: string): Promise<void> {
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
    .values({ id, orgId, userId, title: null })
    .onConflictDoUpdate({
      target: chatSessions.id,
      set: { id: sql`${chatSessions.id}` },
      setWhere: and(eq(chatSessions.orgId, orgId), eq(chatSessions.userId, userId)),
    })
    .returning({ orgId: chatSessions.orgId, userId: chatSessions.userId });
  if (!row || row.orgId !== orgId || row.userId !== userId) {
    throw notFound("Chat session not found");
  }
}

/** Most recent message id in a session — the one a new message follows, or null. */
async function lastMessageId(sessionId: string): Promise<string | null> {
  const [row] = await db
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
  sessionId: string,
  message: UIMessage,
  precedingMessageId: string | null,
): Promise<{ messageId: string; seq: number }> {
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
  const [row] = await db
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
 */
export async function persistUserMessage(sessionId: string, message: UIMessage): Promise<string> {
  const { messageId, seq } = await upsertMessage(
    sessionId,
    message,
    await lastMessageId(sessionId),
  );
  await touchSession(sessionId, "user", seq);
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
  const { seq } = await upsertMessage(sessionId, message, precedingMessageId);
  await touchSession(sessionId, "assistant", seq);
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
 * cost nothing: the upsert would rewrite the row and re-run `touchSession`,
 * re-flagging a session its owner has already read.
 */
export async function persistNotice(
  sessionId: string,
  messageId: string,
  text: string,
): Promise<boolean> {
  const [existing] = await db
    .select({ seq: chatMessages.seq })
    .from(chatMessages)
    .where(and(eq(chatMessages.sessionId, sessionId), eq(chatMessages.messageId, messageId)))
    .limit(1);
  if (existing) return false;
  const message = {
    id: messageId,
    role: "assistant",
    parts: [{ type: "text", text }],
  } as UIMessage;
  const { seq } = await upsertMessage(sessionId, message, await lastMessageId(sessionId));
  await touchSession(sessionId, "assistant", seq);
  return true;
}

/**
 * Bump `updatedAt`, derive a title from the first user message if still unset,
 * and advance the read-state watermark matching the persisted turn: an
 * assistant turn advances `lastAssistantSeq` (the session becomes unread until
 * its owner looks at it), a user turn advances `lastReadSeq` (sending a message
 * implies having seen the thread — keeps headless/API senders from accruing
 * phantom unread). Watermarks are message pointers, monotonic via GREATEST —
 * a replayed/late write can never regress them. Ends by signalling the change
 * over SSE so connected clients refetch instead of polling.
 */
async function touchSession(
  sessionId: string,
  kind: "user" | "assistant",
  seq: number,
): Promise<void> {
  const [session] = await db
    .select({ title: chatSessions.title, orgId: chatSessions.orgId, userId: chatSessions.userId })
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId))
    .limit(1);
  if (!session) return;
  const title = session.title ?? (await deriveTitle(sessionId));
  await db
    .update(chatSessions)
    .set({
      updatedAt: new Date(),
      ...(kind === "assistant"
        ? { lastAssistantSeq: sql`GREATEST(coalesce(${chatSessions.lastAssistantSeq}, 0), ${seq})` }
        : { lastReadSeq: sql`GREATEST(coalesce(${chatSessions.lastReadSeq}, 0), ${seq})` }),
      ...(title !== session.title ? { title } : {}),
    })
    .where(eq(chatSessions.id, sessionId));
  // Detached inside `notifySessionUpdate` itself now, so this call site — on the
  // pre-inference path of every turn — pays nothing, and neither do the six that
  // used to await it for no reason. The `.catch(() => {})` that stood here was
  // dead code either way: the function could not reject.
  notifySessionUpdate(sessionId, session.orgId, session.userId);
}

/**
 * How many of a session's earliest USER messages to inspect for a title.
 *
 * The loop below skips a user message with no text (one carrying only an
 * attachment, say), so this cannot be 1. It used to be unbounded — the query
 * read every message of the session, with no role filter — and it re-ran on
 * every turn for as long as `title` stayed null, i.e. on the FIRST turn of every
 * conversation, the one whose latency the user judges. Ten is far past the point
 * where a conversation that has not yielded a title is going to.
 */
const TITLE_SCAN_LIMIT = 10;

/** First user message's text, trimmed to 60 chars (57 + ellipsis). */
async function deriveTitle(sessionId: string): Promise<string | null> {
  const rows = await db
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
    const text = uiMessageText(content.parts);
    if (text) return text.length > 60 ? `${text.slice(0, 57)}…` : text;
  }
  return null;
}
