// SPDX-License-Identifier: Apache-2.0

// The skills and agents the composer offers; the panel, the pill and the `/` menu share one entry.

import { useQuery } from "@tanstack/react-query";
import { chatCommandsSchema, type ChatCommands } from "../commands.ts";
import { chatPath } from "./chat-route.ts";
import { limitedSpaceOf, useConversationScope } from "./conversation-scope.ts";
import { usePackageAuthoringEnabled } from "./package-authoring-store.ts";
import { useChatHost, useChatTransport, type ChatTransport } from "./runtime-context.ts";

/** `spaceId`: a limited conversation's origin space, absent for the acting set. */
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

function chatCommandsQueryKey(
  orgId: string | undefined,
  spaceId: string | null,
  packageAuthoring: boolean,
): readonly unknown[] {
  return ["packages", "chat-commands", orgId, spaceId, packageAuthoring];
}

/** Under the shell's `["packages"]` prefix, so a package write refreshes it; stale after 5 s. */
export function useChatCommands(wanted: boolean) {
  const { can } = useChatHost();
  const transport = useChatTransport();
  const spaceId = limitedSpaceOf(useConversationScope());
  const packageAuthoring = usePackageAuthoringEnabled();
  return useQuery({
    queryKey: chatCommandsQueryKey(transport?.orgId, spaceId ?? null, packageAuthoring),
    queryFn: () => fetchChatCommands(transport!, spaceId, packageAuthoring),
    enabled: wanted && !!transport && can("chat:write"),
    staleTime: 5_000,
  });
}
