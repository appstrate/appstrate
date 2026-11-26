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

import { useCallback, useMemo } from "react";
import { infiniteQueryOptions, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { usePendingSessionLimits } from "./conversation-limit.ts";
import { keysetPaging } from "@appstrate/ui/keyset-paging";
import { useChatTransport, type ChatTransport } from "./runtime-context.ts";
import {
  fetchSessionsPage,
  flattenSessions,
  sessionQuery,
  sessionsQueryKey,
  sessionsSearchQueryKey,
  type SessionsCache,
  type SessionSummary,
} from "./sessions.ts";

// Re-exported for the app shell: the SSE dispatcher invalidates this PREFIX on
// `chat_session_update` frames (the live keys carry the space filter after it), and
// this module's `"./unread"` entry is the shell's single import surface into
// the chat UI.
export { SESSIONS_QUERY_KEY } from "./sessions.ts";

/** Reconciliation-only refetch — SSE is the primary freshness signal. */
export const SAFETY_NET_REFETCH_MS = 60_000;
/**
 * Backstop while a turn is generating. The `generating` flips are announced by
 * the `chat_session_update` frames the server emits on `claimTurn` /
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
function sessionsQuery(transport: ChatTransport | null | undefined, enabled: boolean, q = "") {
  const spaceId = transport?.spaceId ?? null;
  return infiniteQueryOptions({
    queryKey: q ? sessionsSearchQueryKey(spaceId, q) : sessionsQueryKey(spaceId),
    queryFn: ({ pageParam }) => fetchSessionsPage(transport!, pageParam, q || undefined),
    ...keysetPaging,
    select: flattenSessions,
    // The host hands over a transport once it knows the filter; the key carries it, so a filter
    // change reads its own list.
    enabled: enabled && !!transport,
    refetchInterval: sessionsRefetchInterval,
    refetchIntervalInBackground: false,
  });
}

/**
 * `q` (already trimmed/debounced by the caller) narrows the list to titles
 * containing it, server-side; empty is the plain list and shares its key.
 */
export function useSessions(transport?: ChatTransport, q = "") {
  const contextTransport = useChatTransport();
  // ChatPage owns the provider below its render, so its own observer receives
  // the host transport directly. Descendants read the same one from context.
  const current = transport ?? contextTransport;
  const project = usePendingSessionLimits(current?.orgId);
  const select = useCallback(
    (cache: SessionsCache) => flattenSessions(cache).map(project),
    [project],
  );
  return useInfiniteQuery({ ...sessionsQuery(current, true, q), select });
}

/**
 * One conversation by id, whatever the list's filter (`null`: none): the same cache entry as the
 * chat page's history, so the shell's title, spaces and info read what the thread holds.
 * `enabled: false` holds the read under the same key: what the cache already holds still shows.
 */
export function useSessionDetail(
  id: string | null,
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useSessionDetailQuery(useChatTransport(), id, enabled);
}

function useSessionDetailQuery(
  transport: ChatTransport | undefined | null,
  id: string | null,
  enabled = true,
) {
  const project = usePendingSessionLimits(transport?.orgId);
  return useQuery({
    ...sessionQuery(transport, id),
    enabled,
    select: (row) => row && project(row),
  });
}

/**
 * The server's view of the open conversation `id`: its row in the filtered list, else the
 * conversation itself, which opens in place whatever the filter. One not yet created
 * (`persisted` false) has only the list's local row.
 */
export function useActiveSession(
  transport: ChatTransport | undefined,
  id: string,
  persisted: boolean,
): SessionSummary | undefined {
  const listed = useSessions(transport).data?.find((s) => s.id === id);
  // The detail is only fetched when the list does not hold the row (filtered out, not loaded).
  const detail = useSessionDetailQuery(transport, persisted && !listed ? id : null);
  return listed ?? detail.data ?? undefined;
}

/**
 * Count of conversations with an unread reply, for the app-shell nav badge.
 * `unread` is server-computed per session; this shares the sessions query (same
 * key → one request) with the in-chat list, so the badge and the sidebar dots
 * stay consistent (loaded pages only: an unread reply bumps its session to the head).
 * The viewed conversation is kept read by ChatPage, so it is not counted. Pass
 * `enabled: false` when the chat feature is off.
 */
export function useChatUnreadCount(transport?: ChatTransport, enabled = true): number {
  // The badge is mounted on every page, including before a space is picked.
  const { data } = useInfiniteQuery(sessionsQuery(transport, enabled));
  return useMemo(() => (data ?? []).filter((s) => s.unread).length, [data]);
}

/**
 * Whether the caller has any conversation of their own — the same query as the
 * unread badge, so it costs no request. Undefined until it answers; a failed read is no.
 */
export function useHasChatSessions(transport?: ChatTransport, enabled = true): boolean | undefined {
  const { data, isError } = useInfiniteQuery(sessionsQuery(transport, enabled));
  // A failed read answers "none": undecided would hold the caller's placeholder forever.
  if (isError) return false;
  return data === undefined ? undefined : data.length > 0;
}
