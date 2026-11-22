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
import { usePackageAuthoringEnabled } from "./package-authoring-store.ts";
import { useChatHost, type ChatTransport } from "./runtime-context.ts";

/**
 * `spaceId` is the origin space of a conversation limited to it; absent, the route reads the
 * acting set. `packageAuthoring` is the composer's switch: the catalogue lists drafts by the same
 * rule as the turn.
 */
export async function fetchChatCommands(
  transport: ChatTransport,
  spaceId: string | undefined,
  packageAuthoring: boolean,
): Promise<ChatCommands> {
  const query = new URLSearchParams({
    ...(spaceId && { spaceId }),
    package_authoring: String(packageAuthoring),
  });
  const res = await transport.request(`${chatPath(transport, "/commands")}?${query}`);
  return chatCommandsSchema.parse(await res.json());
}

/** The catalogue's cache entry: by organization, limited space and authoring switch. */
function chatCommandsQueryKey(
  orgId: string | undefined,
  spaceId: string | null,
  packageAuthoring: boolean,
): readonly unknown[] {
  return ["packages", "chat-commands", orgId, spaceId, packageAuthoring];
}

/**
 * Read only when `wanted` and the caller may write the chat (the route's guard). Freshness: the
 * key sits under the shell's `["packages"]` prefix, so a package write made here refreshes it, and
 * a 5 s stale time makes the menu (which turns `wanted` on at each `/`) refetch what a write
 * elsewhere changed; the route's 60/min limit is far from that rate.
 */
export function useChatCommands(transport: ChatTransport | undefined, wanted: boolean) {
  const { can } = useChatHost();
  const spaceId = limitedSpaceOf(useConversationScope());
  const packageAuthoring = usePackageAuthoringEnabled();
  return useQuery({
    queryKey: chatCommandsQueryKey(transport?.orgId, spaceId ?? null, packageAuthoring),
    queryFn: () => fetchChatCommands(transport!, spaceId, packageAuthoring),
    enabled: wanted && !!transport && can("chat:write"),
    staleTime: 5_000,
  });
}
