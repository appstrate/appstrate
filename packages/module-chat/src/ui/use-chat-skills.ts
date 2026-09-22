// SPDX-License-Identifier: Apache-2.0

/**
 * The space's pinnable-skill catalogue, as ONE query.
 *
 * The picker and the `/` popover both render it, and a second `useQuery` call
 * site is a second set of options on the same key — the last observer to render
 * wins, so a `staleTime` or an `enabled` that differs by accident changes the
 * behaviour of the other surface. One hook, one set of options.
 */

import { useQuery } from "@tanstack/react-query";
import {
  chatSkillsQueryKey,
  fetchChatSkills,
  SKILLS_STALE_MS,
  type ChatSkillEntry,
} from "./chat-skills.ts";
import { useChatHeaders } from "./runtime-context.ts";
import { spaceIdFromHeaders } from "./sessions.ts";

/** Stable identity for the empty catalogue, so `useMemo` consumers don't churn. */
const NO_SKILLS: readonly ChatSkillEntry[] = [];

interface ChatSkillsCatalog {
  skills: readonly ChatSkillEntry[];
  /** True only while a request can actually be in flight — see below. */
  loading: boolean;
  failed: boolean;
}

export function useChatSkillsCatalog(): ChatSkillsCatalog {
  const getHeaders = useChatHeaders();
  const spaceId = spaceIdFromHeaders(getHeaders);

  const query = useQuery({
    queryKey: chatSkillsQueryKey(spaceId),
    queryFn: () => fetchChatSkills(getHeaders),
    // `GET /api/chat/skills` requires `X-Space-Id`; without one the request is
    // a guaranteed 400, so wait for the host's space instead.
    enabled: !!spaceId,
    staleTime: SKILLS_STALE_MS,
  });

  return {
    skills: query.data ?? NO_SKILLS,
    // `isPending` stays true forever while the query is disabled, so a missing
    // space must read as "nothing to offer", not as "still loading".
    loading: !!spaceId && query.isPending,
    failed: query.isError,
  };
}
