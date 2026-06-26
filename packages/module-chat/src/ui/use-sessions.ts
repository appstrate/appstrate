// SPDX-License-Identifier: Apache-2.0

/**
 * Shared conversation-list query. Polls fast (2s) while a conversation is
 * generating and slow (8s) otherwise, so the sidebar (relative time, unread
 * badge) stays live without a dedicated SSE channel. A steady idle poll is
 * required: gating polling solely
 * on "already generating" never starts, since the refetch right after a send can
 * race the server setting `active_stream_id` and observe `generating:false`.
 * Pauses when the tab is hidden.
 */

import { useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useChatHeaders, type GetHeaders } from "./runtime-context.ts";
import { fetchSessions, SESSIONS_QUERY_KEY } from "./sessions.ts";
import { subscribeSeen, getSeen, isUnread } from "./unread-store.ts";

const refetchInterval = (q: { state: { data?: { generating: boolean }[] } }) =>
  q.state.data?.some((s) => s.generating) ? 2000 : 8000;

export function useSessions() {
  const getHeaders = useChatHeaders();
  return useQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: () => fetchSessions(getHeaders),
    refetchInterval,
    refetchIntervalInBackground: false,
  });
}

/**
 * Count of conversations with an unread reply, for the app-shell nav badge.
 * Shares the sessions query (same key → one request) and the seen watermark with
 * the in-chat list, so the badge and the sidebar dots stay consistent. The
 * conversation the user is currently viewing is kept read by ChatPage, so it is
 * not counted. Pass `enabled: false` when the chat feature is off.
 */
export function useChatUnreadCount(getHeaders?: GetHeaders, enabled = true): number {
  const seen = useSyncExternalStore(subscribeSeen, getSeen, getSeen);
  const { data } = useQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: () => fetchSessions(getHeaders),
    refetchInterval,
    refetchIntervalInBackground: false,
    enabled,
  });
  return useMemo(
    () => (data ?? []).filter((s) => isUnread(seen, s.id, s.updatedAt)).length,
    [data, seen],
  );
}
