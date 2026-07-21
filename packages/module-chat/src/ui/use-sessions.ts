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
import { useQuery } from "@tanstack/react-query";
import { useChatHeaders, type GetHeaders } from "./runtime-context.ts";
import { fetchSessions, SESSIONS_QUERY_KEY, type SessionSummary } from "./sessions.ts";

// Re-exported for the app shell: the SSE dispatcher invalidates this key on
// `chat_session_update` frames, and this module's `"./unread"` entry is the
// shell's single import surface into the chat UI.
export { SESSIONS_QUERY_KEY } from "./sessions.ts";

/** Reconciliation-only refetch — SSE is the primary freshness signal. */
const SAFETY_NET_REFETCH_MS = 60_000;
/**
 * Fast backstop while a turn is generating. The `generating` flip is announced
 * by a fire-and-forget NOTIFY (realtime.ts) — if that frame is lost (SSE
 * reconnect window, dropped NOTIFY) the sidebar spinner would otherwise stick
 * for up to the 60s safety net. Only active while at least one session reports
 * `generating`, so the idle cost stays the slow interval.
 */
const GENERATING_REFETCH_MS = 3_000;

function sessionsRefetchInterval(query: { state: { data?: SessionSummary[] } }): number {
  return query.state.data?.some((s) => s.generating)
    ? GENERATING_REFETCH_MS
    : SAFETY_NET_REFETCH_MS;
}

export function useSessions() {
  const getHeaders = useChatHeaders();
  return useQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: () => fetchSessions(getHeaders),
    refetchInterval: sessionsRefetchInterval,
    refetchIntervalInBackground: false,
  });
}

/**
 * Count of conversations with an unread reply, for the app-shell nav badge.
 * `unread` is server-computed per session; this shares the sessions query (same
 * key → one request) with the in-chat list, so the badge and the sidebar dots
 * stay consistent. The conversation the user is currently viewing is kept read
 * by ChatPage (server mark-read), so it is not counted. Pass `enabled: false`
 * when the chat feature is off.
 */
export function useChatUnreadCount(getHeaders?: GetHeaders, enabled = true): number {
  const { data } = useQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: () => fetchSessions(getHeaders),
    refetchInterval: sessionsRefetchInterval,
    refetchIntervalInBackground: false,
    enabled,
  });
  return useMemo(() => (data ?? []).filter((s) => s.unread).length, [data]);
}
