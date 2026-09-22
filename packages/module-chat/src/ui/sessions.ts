// SPDX-License-Identifier: Apache-2.0

/**
 * Thin REST helpers over the chat session API. Auth = the host shell's scoping
 * headers (org/space). The server is the single writer of messages, so there is
 * no client message-write helper — only session list/CRUD + history load.
 */

import type { UIMessage } from "ai";
import {
  defaultSkillSelection,
  normalizeDiscovery,
  normalizePinned,
  type SessionHistory,
} from "./chat-skills.ts";
import { requestHeaders } from "./request-headers.ts";
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

/**
 * Prefix every chat-session-list key starts with (module-local, not the typed
 * client). Exported for the app shell, which invalidates on it — a prefix match,
 * so it still reaches the space-scoped keys below.
 */
export const SESSIONS_QUERY_KEY = ["chat", "sessions"] as const;

/**
 * The session list of ONE space. Sessions are space-scoped rows
 * (`chat_sessions.space_id`) and `GET /api/chat/sessions` REQUIRES `X-Space-Id`,
 * so the space belongs in the key twice over: a key without it would serve
 * another space's list from cache, and would stay disabled forever instead of
 * refetching when the space store resolves.
 */
export function sessionsQueryKey(spaceId: string | null): readonly unknown[] {
  return [...SESSIONS_QUERY_KEY, spaceId];
}

/** One conversation's stored history, in one space. */
export function sessionQueryKey(spaceId: string | null, id: string): readonly unknown[] {
  return ["chat", "session", id, spaceId];
}

/**
 * The space the host is scoped to, read off the injected scoping headers —
 * the same value they put in `X-Space-Id`. The module has no space store of its
 * own and must not grow one: the host owns that state and publishes it here.
 */
export function spaceIdFromHeaders(getHeaders: GetHeaders | null | undefined): string | null {
  return getHeaders?.()["X-Space-Id"] ?? null;
}

export async function fetchSessions(
  getHeaders: GetHeaders | null | undefined,
): Promise<SessionSummary[]> {
  const res = await fetch("/api/chat/sessions", {
    credentials: "include",
    headers: requestHeaders(getHeaders),
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
    headers: requestHeaders(getHeaders, true),
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
    headers: requestHeaders(getHeaders),
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
    headers: requestHeaders(getHeaders),
  });
  if (!res.ok) throw new Error(`Failed to mark session read (HTTP ${res.status})`);
}

/** Explicitly stop the server-side producer for an active conversation. */
export async function stopSession(
  getHeaders: GetHeaders | null | undefined,
  id: string,
): Promise<void> {
  const res = await fetch(`/api/chat/sessions/${id}/stop`, {
    method: "POST",
    credentials: "include",
    headers: requestHeaders(getHeaders),
  });
  if (!res.ok) throw new Error(`Failed to stop session (HTTP ${res.status})`);
}

/** A stored message node as returned by `GET /sessions/:id`. */
interface StoredMessage {
  id: string;
  content: Record<string, unknown>;
}

/**
 * A conversation as the detail route serves it: its history, ready to seed
 * `useChat({ messages })`, and its skill selection.
 *
 * Stored `content` is the ai-sdk/v6 UIMessage minus its id (the id rides in the
 * row), so we reconstruct `{ id, ...content }`. A not-yet-persisted session
 * (a freshly-minted id whose first message hasn't been sent) 404s → empty
 * history and the DEFAULT selection, which is exactly what such a session
 * resolves to server-side: the row the first turn (or the picker) creates
 * carries those same defaults.
 *
 * The selection rides along rather than getting a request of its own: the
 * picker and the thread must never disagree about the conversation they are
 * both looking at, and one payload cannot disagree with itself.
 */
export async function loadHistory(
  getHeaders: GetHeaders | null | undefined,
  id: string,
): Promise<SessionHistory> {
  const res = await fetch(`/api/chat/sessions/${id}`, {
    credentials: "include",
    headers: requestHeaders(getHeaders),
  });
  if (res.status === 404) return { messages: [], skills: defaultSkillSelection() };
  if (!res.ok) throw new Error(`Failed to load session (HTTP ${res.status})`);
  const body = (await res.json()) as {
    messages?: StoredMessage[];
    skill_discovery?: unknown;
    pinned_skills?: unknown;
  };
  return {
    // Spread `content` FIRST, then apply the authoritative row `id` — the id
    // lives in `message_id` and `content` is stored without it, but if a stored
    // payload ever carried a stray `id` key, a trailing spread would clobber the
    // real id. Ordering id last makes the row id win.
    messages: (body.messages ?? []).map((e) => ({ ...e.content, id: e.id }) as UIMessage),
    skills: {
      discovery: normalizeDiscovery(body.skill_discovery),
      pinned: normalizePinned(body.pinned_skills),
    },
  };
}
