// SPDX-License-Identifier: Apache-2.0

/**
 * The ACTIVE conversation's skill selection, read from the cache and written
 * through `PUT …/skills`.
 *
 * READ: the selection is part of the session detail payload
 * (`sessionQueryKey`), which `<Conversation>` already loads to seed the thread.
 * This hook OBSERVES that entry (`skipToken` — never its own fetch) so the
 * picker can never show a selection the thread beside it disagrees with, and a
 * conversation switch is a different key, hence fresh state for free. A
 * freshly-minted id has no row and therefore no entry: the defaults below are
 * what the server would answer, so the picker is usable before the first turn.
 *
 * WRITE: patch the cache first (a checkbox must not wait for a round trip),
 * then PUT through a coalescer — one request in flight, newest selection wins
 * (`createSkillsWriter`). The sessions list carries `skill_discovery`, so it is
 * invalidated once each write settles.
 *
 * On failure the optimistic value is NOT rolled back to a guess: the session
 * entry is invalidated instead, so whatever the server really stored is what
 * comes back the next time this conversation is read.
 */

import { useCallback, useMemo } from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createSkillsWriter,
  normalizeDiscovery,
  normalizePinned,
  putSessionSkills,
  togglePinned,
  withSkillSelection,
  type SessionHistory,
  type SessionSkillSelection,
} from "./chat-skills.ts";
import type { SkillDiscovery } from "../skills.ts";
import type { GetHeaders } from "./runtime-context.ts";
import { SESSIONS_QUERY_KEY, sessionQueryKey, spaceIdFromHeaders } from "./sessions.ts";

export interface SessionSkillsController extends SessionSkillSelection {
  setDiscovery: (mode: SkillDiscovery) => void;
  togglePin: (packageId: string) => void;
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

  // Observe-only: `skipToken` disables fetching outright, so this hook adds a
  // cache subscriber and never a request. The session detail has exactly one
  // fetcher (`<Conversation>`), and a second one here would 404-and-cache a
  // conversation that legitimately has no row yet.
  const { data } = useQuery<SessionHistory>({ queryKey, queryFn: skipToken });

  const discovery = normalizeDiscovery(data?.skills.discovery);
  const pinnedSource = data?.skills.pinned;
  const pinned = useMemo(() => normalizePinned(pinnedSource), [pinnedSource]);

  const writer = useMemo(
    () =>
      createSkillsWriter(
        (selection) => putSessionSkills(getHeaders, sessionId, selection),
        (error) => {
          // `skill_discovery` rides on the list rows too, so the sidebar's view
          // of this conversation is refreshed either way; a failed write also
          // drops the optimistic detail entry so the stored truth wins.
          void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
          if (error !== undefined) void queryClient.invalidateQueries({ queryKey });
        },
      ),
    [getHeaders, sessionId, queryKey, queryClient],
  );

  const apply = useCallback(
    (next: SessionSkillSelection) => {
      queryClient.setQueryData<SessionHistory>(queryKey, (prev) => withSkillSelection(prev, next));
      writer.write(next);
    },
    [queryClient, queryKey, writer],
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
      const next = togglePinned(pinned, packageId);
      // `togglePinned` returns the SAME array when the cap refuses the pin —
      // no state change, so no request.
      if (next === pinned) return;
      apply({ discovery, pinned: next });
    },
    [apply, discovery, pinned],
  );

  return { discovery, pinned, setDiscovery, togglePin };
}
