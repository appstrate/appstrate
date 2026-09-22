// SPDX-License-Identifier: Apache-2.0

// ONE query for the picker and the `/` popover: two call sites = two option sets on one key.

import { useQuery } from "@tanstack/react-query";
import type { SkillHint } from "../skills.ts";
import { chatSkillsQueryKey, fetchChatSkills, SKILLS_STALE_MS } from "./chat-skills.ts";
import { useChatHeaders } from "./runtime-context.ts";
import { spaceIdFromHeaders } from "./sessions.ts";

const NO_SKILLS: readonly SkillHint[] = [];

interface ChatSkillsCatalog {
  skills: readonly SkillHint[];
  loading: boolean;
  failed: boolean;
}

export function useChatSkillsCatalog(): ChatSkillsCatalog {
  const getHeaders = useChatHeaders();
  const spaceId = spaceIdFromHeaders(getHeaders);

  const query = useQuery({
    queryKey: chatSkillsQueryKey(spaceId),
    queryFn: () => fetchChatSkills(getHeaders),
    // Without `X-Space-Id` the listing cannot answer; wait for the host's space.
    enabled: !!spaceId,
    staleTime: SKILLS_STALE_MS,
  });

  return {
    skills: query.data ?? NO_SKILLS,
    // A disabled query stays `isPending` forever; no space reads as "nothing".
    loading: !!spaceId && query.isPending,
    failed: query.isError,
  };
}
