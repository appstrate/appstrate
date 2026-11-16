// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { fetchEnforcedSkills } from "./chat-skills.ts";
import { useConversationScope } from "./conversation-scope.ts";
import type { ChatTransport } from "./runtime-context.ts";

/**
 * Shared by the picker and the read-only indicator: what the conversation's space imposes, i.e.
 * its origin space, or the selected space for a conversation not yet started. Off without one
 * (« Vue d'ensemble »): nothing is imposed and nothing is requested. Default staleness (30 s):
 * a library toggle shows on the next mount past it, without a cross-module invalidation.
 */
export function useEnforcedSkills(transport: ChatTransport | undefined) {
  const { originSpaceId } = useConversationScope();
  return useQuery({
    queryKey: ["chat", "enforced-skills", originSpaceId],
    queryFn: () => fetchEnforcedSkills(transport!, originSpaceId!),
    enabled: !!transport && !!originSpaceId,
  });
}
