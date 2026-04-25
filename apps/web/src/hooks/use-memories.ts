// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import type { AgentMemoryItem, PersistenceActorType } from "@appstrate/shared-types";

/** UI-level scope filter for the memory management list. */
export type MemoryScopeFilter = "all" | "shared" | "mine";

type ServerMemory = AgentMemoryItem & {
  actorType: PersistenceActorType;
  actorId: string | null;
};

/**
 * List the memories visible to the caller for a given agent.
 *
 * Reads from the unified `/persistence` endpoint (ADR-011) with `kind=memory`.
 * Members see `shared` rows + their own actor scope; admins see the same.
 *
 * The optional `filter` argument applies a client-side scope filter on top
 * of the rows returned by the server:
 * - `all` (default): every memory the caller can see
 * - `shared`: only `actorType === "shared"` rows
 * - `mine`: every non-shared row (rows scoped to the caller's actor)
 */
export function useAgentMemories(packageId: string | undefined, filter: MemoryScopeFilter = "all") {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["agent-persistence", "memories", orgId, appId, packageId, filter],
    queryFn: async () => {
      const res = await api<{ memories: ServerMemory[] }>(
        `/agents/${packageId}/persistence?kind=memory`,
      );
      const all: ServerMemory[] = res.memories ?? [];
      if (filter === "shared") {
        return all.filter((m) => m.actorType === "shared");
      }
      if (filter === "mine") {
        return all.filter((m) => m.actorType !== "shared");
      }
      return all;
    },
    enabled: !!orgId && !!appId && !!packageId,
  });
}
