// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchSkills } from "./chat-skills.ts";
import { limitedSpaceOf, useConversationScope } from "./conversation-scope.ts";
import { useCanIn, useChatHost, type ChatTransport } from "./runtime-context.ts";

/**
 * The skills the picker chooses from, shared with the composer's chips (one cache entry, so a
 * pinned chip is named by what the picker lists). Read only with `skills:read`: in the origin
 * space for a limited conversation, in some space the chat acts in otherwise.
 */
export function useSkillCatalogue(transport: ChatTransport | undefined) {
  const { actingSpaceIds } = useChatHost();
  const canIn = useCanIn();
  // A limited conversation reaches its origin space alone: its skills, not the acting set's.
  const scope = useConversationScope();
  const limitedSpaceId = limitedSpaceOf(scope);
  const catalogueSpaceIds = useMemo(
    () => (limitedSpaceId ? [limitedSpaceId] : actingSpaceIds),
    [limitedSpaceId, actingSpaceIds],
  );
  const readable = !!transport && canIn(limitedSpaceId, "skills:read");
  const catalogue = useQuery({
    // Under the shell's `["packages","skills"]` prefix, so its invalidations on a
    // skill change reach this entry; `consumer` keeps it a separate cache entry
    // (a different projection of the same route), and the acting set keys it.
    queryKey: ["packages", "skills", { consumer: "chat" }, catalogueSpaceIds],
    queryFn: () => fetchSkills(transport!, catalogueSpaceIds),
    enabled: readable,
    staleTime: 60_000,
  });
  return { catalogue, readable };
}
