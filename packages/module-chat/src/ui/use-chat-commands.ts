// SPDX-License-Identifier: Apache-2.0

/**
 * What the composer offers: the skills the conversation can pin and the agents the caller can
 * launch, read from the chat's own route. The skills panel, the pinned chips and the `/` menu read
 * the same cache entry, so a skill is named the same everywhere.
 */

import { useQuery } from "@tanstack/react-query";
import { chatCommandsSchema, type ChatCommands } from "../commands.ts";
import { chatPath } from "./chat-route.ts";
import { limitedSpaceOf, useConversationScope } from "./conversation-scope.ts";
import { useChatHost, type ChatTransport } from "./runtime-context.ts";

/** `spaceId` is the origin space of a conversation limited to it; absent, the route reads the acting set. */
export async function fetchChatCommands(
  transport: ChatTransport,
  spaceId: string | undefined,
): Promise<ChatCommands> {
  const query = spaceId ? `?${new URLSearchParams({ spaceId })}` : "";
  const res = await transport.request(`${chatPath(transport, "/commands")}${query}`);
  return chatCommandsSchema.parse(await res.json());
}

/** Read only when `wanted` and the caller may write the chat (the route's guard). */
export function useChatCommands(transport: ChatTransport | undefined, wanted: boolean) {
  const { can } = useChatHost();
  const spaceId = limitedSpaceOf(useConversationScope());
  return useQuery({
    // Under the shell's `["packages"]` prefix, so a package write it refreshes reaches this entry.
    queryKey: ["packages", "chat-commands", transport?.orgId, spaceId ?? null],
    queryFn: () => fetchChatCommands(transport!, spaceId),
    enabled: wanted && !!transport && can("chat:write"),
    staleTime: 30_000,
  });
}
