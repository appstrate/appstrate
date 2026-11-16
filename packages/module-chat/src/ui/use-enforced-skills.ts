// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { fetchEnforcedSkills } from "./chat-skills.ts";
import { useConversationScope } from "./conversation-scope.ts";
import { useChatHost, type ChatTransport } from "./runtime-context.ts";

/**
 * Shared by the picker and the composer's skill chips: what the conversation's origin space imposes
 * on its turns (the selected space for a conversation not yet started). The turn loads them only
 * for an origin the author can still act in, so that is the only origin whose skills are shown:
 * none without an origin (« Vue d'ensemble ») or outside the acting set, and nothing is requested
 * then. Default staleness (30 s): a library toggle shows on the next mount past it, without a
 * cross-module invalidation.
 */
export function useEnforcedSkills(transport: ChatTransport | undefined) {
  const { originSpaceId } = useConversationScope();
  const { actingSpaceIds } = useChatHost();
  const actsInOrigin = !!originSpaceId && actingSpaceIds.includes(originSpaceId);
  return useQuery({
    queryKey: ["chat", "enforced-skills", originSpaceId],
    queryFn: () => fetchEnforcedSkills(transport!, originSpaceId!),
    enabled: !!transport && actsInOrigin,
    // A read cached while the origin was actable must not outlive the access.
    select: (skills) => (actsInOrigin ? skills : []),
  });
}
