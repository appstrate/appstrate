// SPDX-License-Identifier: Apache-2.0

/**
 * Thin REST helpers over the chat session API. Auth = the host shell's scoping
 * headers (org/app). The server is the single writer of messages, so there is
 * no client message-write helper — only session list/CRUD + history load.
 */

import type { UIMessage } from "ai";
import type { GetHeaders } from "./runtime-context.ts";

/** Fresh session id, minted client-side (`chs_` shape) — re-exported from the shared module. */
export { mintSessionId } from "../session-id.ts";

export interface SessionSummary {
  id: string;
  title: string | null;
  /** True while a turn is generating — drives the poll cadence + unread badge. */
  generating: boolean;
  /** Server-computed: an assistant reply landed after the caller last read it. */
  unread: boolean;
  /** ISO timestamp of the last activity — surfaced as a relative time in the list. */
  updatedAt: string;
}

/** React Query key for the session list (module-local, not the typed client). */
export const SESSIONS_QUERY_KEY = ["chat", "sessions"] as const;

function headers(getHeaders: GetHeaders | null | undefined, json = false): Record<string, string> {
  return { ...(json ? { "Content-Type": "application/json" } : {}), ...getHeaders?.() };
}

export async function fetchSessions(
  getHeaders: GetHeaders | null | undefined,
): Promise<SessionSummary[]> {
  const res = await fetch("/api/chat/sessions", {
    credentials: "include",
    headers: headers(getHeaders),
  });
  if (!res.ok) throw new Error(`Failed to load sessions (HTTP ${res.status})`);
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
  if (!res.ok) throw new Error(`Failed to rename session (HTTP ${res.status})`);
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
  if (!res.ok) throw new Error(`Failed to delete session (HTTP ${res.status})`);
}

/** Mark the session read server-side (clears `unread`). Idempotent. */
export async function markSessionRead(
  getHeaders: GetHeaders | null | undefined,
  id: string,
): Promise<void> {
  const res = await fetch(`/api/chat/sessions/${id}/read`, {
    method: "PUT",
    credentials: "include",
    headers: headers(getHeaders),
  });
  if (!res.ok) throw new Error(`Failed to mark session read (HTTP ${res.status})`);
}

/** A stored message node as returned by `GET /sessions/:id`. */
interface StoredMessage {
  id: string;
  content: Record<string, unknown>;
}

/**
 * Session history as `UIMessage[]`, ready to seed `useChat({ messages })`.
 * Stored `content` is the ai-sdk/v6 UIMessage minus its id (the id rides in the
 * row), so we reconstruct `{ id, ...content }`. A not-yet-persisted session
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
  if (!res.ok) throw new Error(`Failed to load session (HTTP ${res.status})`);
  const body = (await res.json()) as { messages?: StoredMessage[] };
  // Spread `content` FIRST, then apply the authoritative row `id` — the id
  // lives in `message_id` and `content` is stored without it, but if a stored
  // payload ever carried a stray `id` key, a trailing spread would clobber the
  // real id. Ordering id last makes the row id win.
  return (body.messages ?? []).map((e) => ({ ...e.content, id: e.id }) as UIMessage);
}
