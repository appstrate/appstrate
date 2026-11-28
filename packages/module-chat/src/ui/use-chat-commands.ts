// SPDX-License-Identifier: Apache-2.0

// The skills and agents the composer offers; the panel, the pill and the `/` menu share one entry.

import { useQuery } from "@tanstack/react-query";
import { chatCommandsSchema, type ChatAgentCommand, type ChatCommands } from "../commands.ts";
import { chatPath } from "./chat-route.ts";
import {
  limitedSpaceOf,
  useConversationScope,
  useConversationTurnCan,
} from "./conversation-scope.ts";
import { usePackageAuthoringEnabled } from "./package-authoring-store.ts";
import { useChatTransport, type ChatTransport } from "./runtime-context.ts";

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

/**
 * Under the shell's `["packages"]` prefix, so a package write refreshes it. Otherwise fresh for
 * five minutes: the catalogue changes only on a package write, and a run's line reads it too.
 */
export function useChatCommands(wanted: boolean) {
  const can = useConversationTurnCan();
  const transport = useChatTransport();
  const spaceId = limitedSpaceOf(useConversationScope());
  const packageAuthoring = usePackageAuthoringEnabled();
  return useQuery({
    queryKey: chatCommandsQueryKey(transport?.orgId, spaceId ?? null, packageAuthoring),
    queryFn: () => fetchChatCommands(transport!, spaceId, packageAuthoring),
    // The route's gate: a space where the chat acts (`can` reads only those). A reader has none.
    enabled: wanted && !!transport && can("chat:write"),
    staleTime: COMMANDS_STALE_MS,
  });
}

const COMMANDS_STALE_MS = 5 * 60_000;

/**
 * How an agent is looked up in the commands data: by its prompt name (one per agent and space),
 * or by its package id, in `spaceId` when the caller knows the space.
 */
export type AgentRef = { promptName: string } | { packageId: string; spaceId?: string };

/** Whether `agent` is the entry `agentRef` names. */
function matchesAgentRef(agent: ChatAgentCommand, agentRef: AgentRef): boolean {
  if ("promptName" in agentRef) return agent.name === agentRef.promptName;
  return (
    agent.packageId === agentRef.packageId &&
    (agentRef.spaceId === undefined || agent.spaceId === agentRef.spaceId)
  );
}

/**
 * The commands entry of an agent (its key is shared with the `/` menu); none for `undefined`.
 * Named with a space, it is that space's install, or none when the agent is not offered there;
 * named without one, an agent installed in several spaces is read from its first entry, whose
 * per-install facts (its integrations) may be another space's.
 */
export function useKnownAgent(agentRef: AgentRef | undefined): ChatAgentCommand | undefined {
  const { data } = useChatCommands(agentRef !== undefined);
  if (!agentRef) return undefined;
  return data?.agents.find((agent) => matchesAgentRef(agent, agentRef));
}
