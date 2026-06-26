// SPDX-License-Identifier: Apache-2.0

/**
 * Thin REST helpers over the chat session API. Auth = the host shell's scoping
 * headers (org/app). The server is the single writer of messages, so there is
 * no client message-write helper — only session list/CRUD + history load.
 */

import type { UIMessage } from "ai";
import type { GetHeaders } from "./runtime-context.ts";

export interface SessionSummary {
  id: string;
  title: string | null;
  /** True while a turn is generating — drives the poll cadence + unread badge. */
  generating: boolean;
  /** ISO timestamp of the last activity — surfaced as a relative time in the list. */
  updatedAt: string;
}

/** React Query key for the conversation list (module-local, not the typed client). */
export const SESSIONS_QUERY_KEY = ["chat", "sessions"] as const;

function headers(getHeaders: GetHeaders | null | undefined, json = false): Record<string, string> {
  return { ...(json ? { "Content-Type": "application/json" } : {}), ...getHeaders?.() };
}

/** A fresh conversation id, minted client-side (matches the server's `chs_` shape). */
export function mintSessionId(): string {
  return `chs_${crypto.randomUUID().replace(/-/g, "")}`;
}

export async function fetchSessions(
  getHeaders: GetHeaders | null | undefined,
): Promise<SessionSummary[]> {
  const res = await fetch("/api/chat/sessions", {
    credentials: "include",
    headers: headers(getHeaders),
  });
  if (!res.ok) throw new Error(`Failed to load conversations (HTTP ${res.status})`);
  return ((await res.json()) as { data?: SessionSummary[] }).data ?? [];
}

export async function renameSession(
  getHeaders: GetHeaders | null | undefined,
  id: string,
  title: string,
): Promise<void> {
  const res = await fetch(`/api/chat/sessions/${id}`, {
    method: "PATCH",
    credentials: "include",
    headers: headers(getHeaders, true),
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`Failed to rename conversation (HTTP ${res.status})`);
}

export async function deleteSession(
  getHeaders: GetHeaders | null | undefined,
  id: string,
): Promise<void> {
  const res = await fetch(`/api/chat/sessions/${id}`, {
    method: "DELETE",
    credentials: "include",
    headers: headers(getHeaders),
  });
  if (!res.ok) throw new Error(`Failed to delete conversation (HTTP ${res.status})`);
}

/** A stored message node as returned by `GET /sessions/:id`. */
interface StoredEntry {
  id: string;
  content: Record<string, unknown>;
}

/**
 * Conversation history as `UIMessage[]`, ready to seed `useChat({ messages })`.
 * Stored `content` is the ai-sdk/v6 UIMessage minus its id (the id rides in the
 * row), so we reconstruct `{ id, ...content }`. A not-yet-persisted conversation
 * (a freshly-minted id whose first message hasn't been sent) 404s → empty.
 */
export async function loadHistory(
  getHeaders: GetHeaders | null | undefined,
  id: string,
): Promise<UIMessage[]> {
  const res = await fetch(`/api/chat/sessions/${id}`, {
    credentials: "include",
    headers: headers(getHeaders),
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Failed to load conversation (HTTP ${res.status})`);
  const body = (await res.json()) as { messages?: StoredEntry[] };
  return (body.messages ?? []).map((e) => ({ id: e.id, ...e.content }) as UIMessage);
}
