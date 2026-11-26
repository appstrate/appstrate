// SPDX-License-Identifier: Apache-2.0

import { $api } from "../../api/client";
import { useAgents } from "../../hooks/use-packages";
import { useFiles } from "../../hooks/use-files";
import { useAdmittingSpaces } from "../../hooks/use-overview-mode";
import { useRunAgentName } from "../../hooks/use-run-agent-name";
import { useListScope } from "../../hooks/use-org-scope";

/**
 * What a panel read shows: its answer once it has one, kept through a refetch that fails; its
 * error only while it holds nothing; else its wait (on its way, or held while the panel is closed).
 */
export function readShown(query: { data: unknown; error: unknown }): "ready" | "error" | "pending" {
  if (query.data !== undefined) return "ready";
  return query.error ? "error" : "pending";
}

/** The runs a conversation launched, in every space the reader reads runs in, newest first. */
export function useConversationRuns(conversationId: string | null, active: boolean) {
  const admitting = useAdmittingSpaces("runs");
  const canRead = admitting.length > 0;
  // Spanning: the conversation's runs are every space's, polled (the SSE stream carries one space).
  const scope = useListScope(true, canRead);
  // Their agents are every space's too: read from the index spanning spaces, while shown.
  const shown = active && !!conversationId;
  const { data: agents } = useAgents({ spanning: true, enabled: shown });
  const agentById = new Map((agents ?? []).map((agent) => [agent.id, agent] as const));
  const agentName = useRunAgentName({ spanning: true, enabled: shown });
  const filters = { chat_session_id: conversationId ?? undefined, limit: 100 };
  // A conversation belongs to the organization: the runs it launched, in every space.
  const query = $api.useQuery(
    "get",
    "/api/orgs/{orgId}/runs",
    { params: { path: { orgId: scope.orgId ?? "" }, query: filters } },
    {
      enabled: scope.enabled && canRead && shown,
      refetchInterval: scope.refetchInterval,
    },
  );
  return {
    query,
    runs: query.data?.data ?? [],
    total: query.data?.total ?? 0,
    agentName,
    agentById,
    // The list spans the spaces the reader reads runs in: each row names its own once there are several.
    spanning: admitting.length > 1,
  };
}

/** The files of a conversation, in every space the reader reads files in, newest first. */
export function useConversationFiles(conversationId: string | null, active: boolean) {
  const admitting = useAdmittingSpaces("files");
  const query = useFiles({
    spanning: true,
    contextChatSessionId: conversationId ?? undefined,
    limit: 100,
    enabled: active && !!conversationId,
  });
  return {
    query,
    files: query.data?.data ?? [],
    hasMore: query.data?.hasMore ?? false,
    // Each row names its space once there are several.
    named: admitting.length > 1,
  };
}
