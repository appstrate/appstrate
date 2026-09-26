// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { fetchEnforcedSkills } from "./chat-skills.ts";
import type { GetHeaders } from "./runtime-context.ts";
import { spaceIdFromHeaders } from "./sessions.ts";

/**
 * Shared by the picker and the read-only indicator. Default staleness: each
 * mount refetches, so a library toggle shows without a cross-module invalidation.
 */
export function useEnforcedSkills(getHeaders: GetHeaders | undefined) {
  const spaceId = spaceIdFromHeaders(getHeaders);
  return useQuery({
    queryKey: ["chat", "enforced-skills", spaceId],
    queryFn: () => fetchEnforcedSkills(getHeaders),
    enabled: !!spaceId,
  });
}
