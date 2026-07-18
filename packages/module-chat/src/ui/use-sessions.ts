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

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useChatHeaders, type GetHeaders } from "./runtime-context.ts";
import { fetchSessions, SESSIONS_QUERY_KEY } from "./sessions.ts";

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
    refetchInterval,
    refetchIntervalInBackground: false,
    enabled,
  });
  return useMemo(() => (data ?? []).filter((s) => s.unread).length, [data]);
}
