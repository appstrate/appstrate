// SPDX-License-Identifier: Apache-2.0

/**
 * Thin REST helpers over the chat session API, sent through the host's `request`
 * (scoping headers added, RFC 9457 failures thrown as the host's error). The server
 * is the single writer of messages, so there is no client message-write helper —
 * only session list/CRUD + history load.
 */

import type { InfiniteData } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import type { ChatSkillMode } from "@appstrate/db/schema";
import type { ChatSkillSelection } from "../skills.ts";
import { errorStatus, jsonInit, type ChatTransport } from "./runtime-context.ts";
import { chatPath } from "./scope.ts";

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
  /** The space of a space session; `null` for an organization session. */
  spaceId: string | null;
  /** The spaces an organization session touched; empty for a space session. */
  space_ids: string[];
}

/**
 * Prefix every chat-session-list key starts with (module-local, not the typed
 * client). Exported for the app shell, which invalidates on it — a prefix match,
 * so it still reaches the space-scoped keys below.
 */
export const SESSIONS_QUERY_KEY = ["chat", "sessions"] as const;

/**
 * The session list of ONE scope (`chatScopeKey`: a space, or the organization). Sessions are
 * space-scoped rows and `GET /api/chat/sessions` REQUIRES `X-Space-Id`, so the scope belongs in
 * the key twice over: a key without it would serve another space's list from cache, and would stay
 * disabled forever instead of refetching when the space store resolves.
 */
export function sessionsQueryKey(scopeKey: string | null): readonly unknown[] {
  return [...SESSIONS_QUERY_KEY, scopeKey];
}

/**
 * The title-search results of ONE space. Nested under `sessionsQueryKey` on
 * purpose: an invalidation (or `setQueriesData`) on the prefix reaches the
 * filtered lists too. The default list's key shape is unchanged — the
 * local-first patch in `index.tsx` addresses it exactly.
 */
export function sessionsSearchQueryKey(scopeKey: string | null, q: string): readonly unknown[] {
  return [...sessionsQueryKey(scopeKey), "search", q];
}

/** One conversation's stored history, in one scope. */
export function sessionQueryKey(scopeKey: string | null, id: string): readonly unknown[] {
  return ["chat", "session", id, scopeKey];
}

export interface SessionsPage {
  data: SessionSummary[];
  hasMore: boolean;
}

export type SessionsCache = InfiniteData<SessionsPage, string | undefined>;

export async function fetchSessionsPage(
  transport: ChatTransport,
  startingAfter: string | undefined,
  q?: string,
): Promise<SessionsPage> {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (startingAfter) params.set("startingAfter", startingAfter);
  const query = params.size > 0 ? `?${params}` : "";
  const res = await transport.request(chatPath(transport, `/sessions${query}`));
  const body = (await res.json()) as Partial<SessionsPage>;
  return { data: body.data ?? [], hasMore: body.hasMore ?? false };
}

/** Patch every loaded page (`first` = head page); an absent cache stays absent unless seeded. */
export function patchSessionsCache(
  prev: SessionsCache | undefined,
  fn: (rows: SessionSummary[], first: boolean) => SessionSummary[],
  seed?: SessionSummary,
): SessionsCache | undefined {
  if (!prev)
    return seed ? { pages: [{ data: [seed], hasMore: false }], pageParams: [undefined] } : prev;
  return { ...prev, pages: prev.pages.map((p, i) => ({ ...p, data: fn(p.data, i === 0) })) };
}

/** Flatten the loaded pages; a row seen twice (bumped mid-walk) keeps its first occurrence. */
export function flattenSessions(cache: SessionsCache): SessionSummary[] {
  const seen = new Set<string>();
  return cache.pages.flatMap((p) => p.data.filter((s) => !seen.has(s.id) && seen.add(s.id)));
}

export async function renameSession(
  transport: ChatTransport,
  id: string,
  title: string,
): Promise<void> {
  await transport.request(chatPath(transport, `/sessions/${id}`), jsonInit("PATCH", { title }));
}

export async function deleteSession(transport: ChatTransport, id: string): Promise<void> {
  await transport.request(chatPath(transport, `/sessions/${id}`), { method: "DELETE" });
}

/** Mark the session read server-side (clears `unread`). Idempotent. */
export async function markSessionRead(transport: ChatTransport, id: string): Promise<void> {
  await transport.request(chatPath(transport, `/sessions/${id}/read`), { method: "PUT" });
}

/** Explicitly stop the server-side producer for an active conversation. */
export async function stopSession(transport: ChatTransport, id: string): Promise<void> {
  await transport.request(chatPath(transport, `/sessions/${id}/stop`), { method: "POST" });
}

/** A stored message node as returned by `GET /sessions/:id`. */
interface StoredMessage {
  id: string;
  content: Record<string, unknown>;
}

/** A conversation as the detail route serves it: history + skill selection. */
interface SessionHistory {
  messages: UIMessage[];
  skills: ChatSkillSelection;
}

/**
 * Stored `content` is the ai-sdk/v6 UIMessage minus its id (the id rides in the
 * row), so we reconstruct `{ id, ...content }`. `null` when the caller has no
 * such conversation (the route's 404).
 */
export async function loadHistory(
  transport: ChatTransport,
  id: string,
): Promise<SessionHistory | null> {
  let res: Response;
  try {
    res = await transport.request(chatPath(transport, `/sessions/${id}`));
  } catch (error) {
    if (errorStatus(error) === 404) return null;
    throw error;
  }
  const body = (await res.json()) as {
    messages?: StoredMessage[];
    skill_mode: ChatSkillMode;
    pinned_skills: string[];
  };
  return {
    // Row `id` LAST: a stray `id` inside a stored `content` must not win.
    messages: (body.messages ?? []).map((e) => ({ ...e.content, id: e.id }) as UIMessage),
    skills: { skillMode: body.skill_mode, pinnedSkills: body.pinned_skills },
  };
}
