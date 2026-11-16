// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { fetchEnforcedSkills } from "./chat-skills.ts";
import type { ChatTransport } from "./runtime-context.ts";

/**
 * Shared by the picker and the read-only indicator. Default staleness (30 s):
 * a library toggle shows on the next mount past it, without a cross-module
 * invalidation.
 */
export function useEnforcedSkills(transport: ChatTransport | undefined) {
  return useQuery({
    queryKey: ["chat", "enforced-skills"],
    queryFn: () => fetchEnforcedSkills(transport!),
    enabled: !!transport,
  });
}
