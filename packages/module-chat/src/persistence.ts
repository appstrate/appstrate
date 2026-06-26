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
 * `message_id`), `format` = `"ai-sdk/v6"`, `parent_id` chains messages linearly.
 */

import { desc, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { chatMessages, chatSessions } from "@appstrate/db/schema";
import { notFound } from "@appstrate/core/api-errors";
import { uiMessageText } from "./message-text.ts";
import type { UIMessage } from "ai";

/** assistant-ui ai-sdk MessageFormatAdapter id — keep in sync with the client. */
export const CHAT_MESSAGE_FORMAT = "ai-sdk/v6";

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
  await db
    .insert(chatSessions)
    .values({ id, orgId, userId, title: null })
    .onConflictDoNothing({ target: chatSessions.id });
  // The id is client-minted, so a caller could send an id that already belongs
  // to another tenant; onConflictDoNothing would leave that row intact and we'd
  // then persist a message into it. Confirm ownership after the upsert (the row
  // exists by now) and refuse otherwise — 404, not 403, so we don't reveal that
  // the id exists for someone else.
  const [row] = await db
    .select({ orgId: chatSessions.orgId, userId: chatSessions.userId })
    .from(chatSessions)
    .where(eq(chatSessions.id, id))
    .limit(1);
  if (!row || row.orgId !== orgId || row.userId !== userId) {
    throw notFound("Conversation not found");
  }
}

/** Most recent message id in a session (the parent for the next turn), or null. */
async function lastMessageId(sessionId: string): Promise<string | null> {
  const [row] = await db
    .select({ messageId: chatMessages.messageId })
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(desc(chatMessages.seq))
    .limit(1);
  return row?.messageId ?? null;
}

async function upsertMessage(
  sessionId: string,
  message: UIMessage,
  parentId: string | null,
): Promise<string> {
  // The row is keyed by (sessionId, messageId). The assistant UIMessage parsed
  // from the stream can arrive WITHOUT an id (the engine's start chunk may omit
  // `messageId`); an empty id would collide across turns and silently overwrite
  // an earlier message (e.g. the OAuth-card turn vanishing after a resume).
  // Mint a stable unique id whenever one is missing.
  const messageId = message.id || crypto.randomUUID();
  const content = toContent(message) as typeof chatMessages.$inferInsert.content;
  await db
    .insert(chatMessages)
    .values({
      sessionId,
      messageId,
      parentId,
      format: CHAT_MESSAGE_FORMAT,
      content,
    })
    .onConflictDoUpdate({
      target: [chatMessages.sessionId, chatMessages.messageId],
      set: { parentId, content, format: CHAT_MESSAGE_FORMAT },
    });
  return messageId;
}

/**
 * Persist the user turn BEFORE inference starts, chained onto the last message.
 * Returns the user message id so the assistant turn can chain onto it.
 */
export async function persistUserMessage(sessionId: string, message: UIMessage): Promise<string> {
  const parentId = await lastMessageId(sessionId);
  const messageId = await upsertMessage(sessionId, message, parentId);
  await touchSession(sessionId);
  return messageId;
}

/** Persist the assistant turn when the stream finalizes, chained onto the user turn. */
export async function persistAssistantMessage(
  sessionId: string,
  message: UIMessage,
  userMessageId: string,
): Promise<void> {
  await upsertMessage(sessionId, message, userMessageId);
  await touchSession(sessionId);
}

/** Bump `updatedAt` and derive a title from the first user message if still unset. */
async function touchSession(sessionId: string): Promise<void> {
  const [session] = await db
    .select({ title: chatSessions.title })
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId))
    .limit(1);
  if (!session) return;
  const title = session.title ?? (await deriveTitle(sessionId));
  await db
    .update(chatSessions)
    .set({ updatedAt: new Date(), ...(title !== session.title ? { title } : {}) })
    .where(eq(chatSessions.id, sessionId));
}

/** First user message's text, trimmed to 60 chars (57 + ellipsis). */
async function deriveTitle(sessionId: string): Promise<string | null> {
  const rows = await db
    .select({ content: chatMessages.content })
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(chatMessages.seq);
  for (const row of rows) {
    const content = row.content as { role?: string; parts?: unknown[] };
    if (content?.role !== "user" || !Array.isArray(content.parts)) continue;
    const text = uiMessageText(content.parts);
    if (text) return text.length > 60 ? `${text.slice(0, 57)}…` : text;
  }
  return null;
}
