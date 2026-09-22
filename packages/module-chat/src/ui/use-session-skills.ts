// SPDX-License-Identifier: Apache-2.0

/**
 * The ACTIVE conversation's skill selection, read from the cache and written
 * through `PUT …/skills`.
 *
 * READ: the selection rides on the session detail payload (`sessionQueryKey`)
 * that `<Conversation>` already loads, so this hook is a SECOND OBSERVER of
 * that entry and never a second fetcher. Its options must stay identical to the
 * owner's (`index.tsx`), `enabled` aside: React Query MERGES options across
 * observers rather than scoping them, so a default `gcTime` here would keep a
 * stale history cached five minutes past unmount (the max wins) and re-seed a
 * returning user with it, and a `queryFn: skipToken` here would be the one left
 * on the Query, making an `invalidateQueries` reject with "Missing queryFn".
 *
 * WRITE: patch the cache first (a checkbox must not wait for a round trip),
 * then PUT through a coalescer — one request in flight, newest selection wins.
 * The sessions list carries `skill_discovery`, so it is invalidated once each
 * write settles. On failure the optimistic value is NOT rolled back to a guess:
 * the session entry is invalidated instead, so the stored truth is what comes
 * back the next time this conversation is read.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createSkillsWriter,
  normalizeDiscovery,
  normalizePinned,
  putSessionSkills,
  togglePinned,
  withSkillSelection,
  type SessionHistory,
  type SessionSkillSelection,
  type SkillsWriter,
} from "./chat-skills.ts";
import { MAX_PINNED_SKILLS, type SkillDiscovery } from "../skills.ts";
import type { GetHeaders } from "./runtime-context.ts";
import {
  loadHistory,
  SESSIONS_QUERY_KEY,
  sessionQueryKey,
  spaceIdFromHeaders,
} from "./sessions.ts";

export interface SessionSkillsController extends SessionSkillSelection {
  setDiscovery: (mode: SkillDiscovery) => void;
  togglePin: (packageId: string) => void;
  /** True when one more pin would exceed the server's cap — the UI says so. */
  atPinCap: boolean;
}

export function useSessionSkills(
  sessionId: string,
  getHeaders: GetHeaders | null | undefined,
): SessionSkillsController {
  const queryClient = useQueryClient();
  const spaceId = spaceIdFromHeaders(getHeaders);
  // Memoised so it is a stable dependency below: the key's CONTENTS identify
  // the conversation, its array identity changes on every render.
  const queryKey = useMemo(() => sessionQueryKey(spaceId, sessionId), [spaceId, sessionId]);

  // Read through a ref so the coalescer below depends on the conversation alone.
  const headersRef = useRef(getHeaders);
  useEffect(() => {
    headersRef.current = getHeaders;
  }, [getHeaders]);

  const { data } = useQuery<SessionHistory>({
    queryKey,
    queryFn: () => loadHistory(headersRef.current, sessionId),
    enabled: false,
    staleTime: Infinity,
    gcTime: 0,
  });

  const discovery = normalizeDiscovery(data?.skills.discovery);
  const pinnedSource = data?.skills.pinned;
  const pinned = useMemo(() => normalizePinned(pinnedSource), [pinnedSource]);

  // Built in an event handler, never in render: the coalescer holds an in-flight
  // request and a queued selection, so a mid-flight rebuild drops the queue.
  const writerRef = useRef<{ sessionId: string; writer: SkillsWriter } | null>(null);
  const getWriter = useCallback((): SkillsWriter => {
    const held = writerRef.current;
    if (held?.sessionId === sessionId) return held.writer;
    const writer = createSkillsWriter(
      (selection) => putSessionSkills(headersRef.current, sessionId, selection),
      (error) => {
        // `skill_discovery` rides on the list rows too, so the sidebar refreshes
        // either way; a failure also drops the optimistic detail entry.
        void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
        if (error !== undefined) {
          const key = sessionQueryKey(spaceIdFromHeaders(headersRef.current), sessionId);
          void queryClient.invalidateQueries({ queryKey: key });
        }
      },
    );
    writerRef.current = { sessionId, writer };
    return writer;
  }, [sessionId, queryClient]);

  const apply = useCallback(
    (next: SessionSkillSelection) => {
      queryClient.setQueryData<SessionHistory>(queryKey, (prev) => withSkillSelection(prev, next));
      getWriter().write(next);
    },
    [queryClient, queryKey, getWriter],
  );

  const setDiscovery = useCallback(
    (mode: SkillDiscovery) => {
      if (mode === discovery) return;
      apply({ discovery: mode, pinned });
    },
    [apply, discovery, pinned],
  );

  const togglePin = useCallback(
    (packageId: string) => {
      // The SAME array back means the cap refused the pin: no change, no request.
      const next = togglePinned(pinned, packageId);
      if (next === pinned) return;
      apply({ discovery, pinned: next });
    },
    [apply, discovery, pinned],
  );

  return {
    discovery,
    pinned,
    setDiscovery,
    togglePin,
    atPinCap: pinned.length >= MAX_PINNED_SKILLS,
  };
}
