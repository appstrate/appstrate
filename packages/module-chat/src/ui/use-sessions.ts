// SPDX-License-Identifier: Apache-2.0

/**
 * Shared conversation-list query. Freshness is PUSH-driven: the server emits a
 * `chat_session_update` SSE frame on every session change (message persisted,
 * read marker advanced, rename, delete, `generating` flip) and the app shell
 * invalidates this query (`use-global-run-sync.ts`), so the sidebar, spinner
 * and unread badges update live without polling. The slow interval below is a
 * safety net only — it reconciles a missed signal (SSE reconnect window,
 * dropped NOTIFY) and is paused while the tab is hidden.
 */

import { useMemo } from "react";
import { infiniteQueryOptions, useInfiniteQuery } from "@tanstack/react-query";
import { useChatHeaders, type GetHeaders } from "./runtime-context.ts";
import {
  fetchSessionsPage,
  flattenSessions,
  sessionsQueryKey,
  spaceIdFromHeaders,
  type SessionsCache,
} from "./sessions.ts";

// Re-exported for the app shell: the SSE dispatcher invalidates this PREFIX on
// `chat_session_update` frames (the live keys carry the space id after it), and
// this module's `"./unread"` entry is the shell's single import surface into
// the chat UI.
export { SESSIONS_QUERY_KEY } from "./sessions.ts";

/** Reconciliation-only refetch — SSE is the primary freshness signal. */
export const SAFETY_NET_REFETCH_MS = 60_000;
/**
 * Backstop while a turn is generating. The `generating` flips are announced by
 * the `chat_session_update` frames the server emits on `setActiveStream` /
 * `clearActiveStream` — that push is the primary signal, and it is what makes
 * the spinner react within a round trip. This interval only covers a LOST
 * frame (SSE reconnect window, dropped NOTIFY): the next poll reads the row's
 * real state. A marker whose producer died is cleared by the resume route
 * when that conversation is next opened (or at boot without Redis), not by
 * this poll. Only active while at least one session reports `generating`, so
 * the idle cost stays the slow interval.
 */
export const GENERATING_REFETCH_MS = 10_000;

/**
 * `refetchInterval` callback for the session-list query. Exported for its
 * test; the two constants above are the only thing it decides between.
 */
export function sessionsRefetchInterval(query: {
  state: { data?: SessionsCache | undefined };
}): number {
  return query.state.data?.pages.some((p) => p.data.some((s) => s.generating))
    ? GENERATING_REFETCH_MS
    : SAFETY_NET_REFETCH_MS;
}

/** The session-list query, shared by the list and the nav badge (one key, one request). */
function sessionsQuery(getHeaders: GetHeaders | null | undefined, enabled: boolean) {
  const spaceId = spaceIdFromHeaders(getHeaders);
  return infiniteQueryOptions({
    queryKey: sessionsQueryKey(spaceId),
    queryFn: ({ pageParam }) => fetchSessionsPage(getHeaders, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) =>
      last.hasMore ? (last.data[last.data.length - 1]?.id ?? null) : null,
    select: flattenSessions,
    // The route requires `X-Space-Id`. Firing before the host's space store
    // resolves (first login, org switch) would be a guaranteed 400; the key
    // carries the space, so it refetches the moment one arrives.
    enabled: enabled && !!spaceId,
    refetchInterval: sessionsRefetchInterval,
    refetchIntervalInBackground: false,
  });
}

export function useSessions(headers?: GetHeaders) {
  const contextHeaders = useChatHeaders();
  // ChatPage owns the provider below its render, so its own observer receives
  // the host headers directly. Descendants read the same headers from context.
  return useInfiniteQuery(sessionsQuery(headers ?? contextHeaders, true));
}

/**
 * Count of conversations with an unread reply, for the app-shell nav badge.
 * `unread` is server-computed per session; this shares the sessions query (same
 * key → one request) with the in-chat list, so the badge and the sidebar dots
 * stay consistent (loaded pages only: an unread reply bumps its session to the head).
 * The viewed conversation is kept read by ChatPage, so it is not counted. Pass
 * `enabled: false` when the chat feature is off.
 */
export function useChatUnreadCount(getHeaders?: GetHeaders, enabled = true): number {
  // The badge is mounted on every page, including before a space is picked.
  const { data } = useInfiniteQuery(sessionsQuery(getHeaders, enabled));
  return useMemo(() => (data ?? []).filter((s) => s.unread).length, [data]);
}
