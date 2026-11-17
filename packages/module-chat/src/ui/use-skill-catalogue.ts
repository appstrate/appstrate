// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { fetchSkills } from "./chat-skills.ts";
import { useChatHost, type ChatTransport } from "./runtime-context.ts";
import { spaceIdFromHeaders } from "./sessions.ts";

/**
 * The skills the picker chooses from, shared with the composer's chips (one cache entry, so a
 * pinned chip is named by what the picker lists). Read only when `wanted`, with `skills:read`, in
 * the space the transport is scoped to.
 */
export function useSkillCatalogue(transport: ChatTransport | undefined, wanted: boolean) {
  const { can } = useChatHost();
  const spaceId = spaceIdFromHeaders(transport?.getHeaders);
  const enabled = wanted && !!spaceId && !!transport && can("skills:read");
  const catalogue = useQuery({
    // Under the shell's `["packages","skills"]` prefix, so its invalidations on a
    // skill change reach this entry; `consumer` keeps it a separate cache entry
    // (a different projection of the same route), and the space scopes it.
    queryKey: ["packages", "skills", { consumer: "chat" }, spaceId],
    queryFn: () => fetchSkills(transport!.request),
    enabled,
    staleTime: 60_000,
  });
  return { catalogue };
}
