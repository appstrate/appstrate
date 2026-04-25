// SPDX-License-Identifier: Apache-2.0

/**
 * Unified persistence hooks (ADR-011) — checkpoints + memories.
 *
 * Reads go through `GET /agents/:id/persistence` with `kind` and optional
 * `runId` filters. The same `usePersistenceQuery` factor backs every read
 * hook so cache keys, scope-filter logic, and `enabled` semantics stay in
 * one place.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AgentCheckpointItem,
  AgentMemoryItem,
  PersistenceActorType,
} from "@appstrate/shared-types";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import { onMutationError } from "./use-mutations";
import type { PersistenceScopeFilter } from "../components/persistence/scope-filter";

type ServerMemory = Omit<AgentMemoryItem, "actorType" | "actorId"> & {
  actorType: PersistenceActorType;
  actorId: string | null;
};

interface PersistenceResponse {
  checkpoints?: AgentCheckpointItem[];
  memories?: ServerMemory[];
}

/**
 * Internal factor: one React Query subscription against `/persistence` with
 * arbitrary query params. Caller passes a stable scope tag (e.g. `"agent"`,
 * `"run:abc"`) so simultaneous run-level + agent-level views don't share a
 * cache slot.
 */
function usePersistenceQuery<T>(
  packageId: string | undefined,
  scopeTag: string,
  params: Record<string, string | undefined>,
  pick: (res: PersistenceResponse) => T,
) {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["agent-persistence", scopeTag, orgId, appId, packageId, params],
    queryFn: async () => {
      const search = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v !== undefined) search.set(k, v);
      const qs = search.toString();
      const res = await api<PersistenceResponse>(
        `/agents/${packageId}/persistence${qs ? `?${qs}` : ""}`,
      );
      return pick(res);
    },
    enabled: !!orgId && !!appId && !!packageId,
  });
}

function applyScopeFilter<T extends { actorType: PersistenceActorType }>(
  rows: T[],
  filter: PersistenceScopeFilter,
): T[] {
  if (filter === "shared") return rows.filter((r) => r.actorType === "shared");
  if (filter === "mine") return rows.filter((r) => r.actorType !== "shared");
  return rows;
}

/**
 * Memories visible to the caller for an agent, with an optional client-side
 * scope filter on top of what the server returned.
 */
export function useAgentMemories(
  packageId: string | undefined,
  filter: PersistenceScopeFilter = "all",
) {
  return usePersistenceQuery(packageId, `agent-memories:${filter}`, { kind: "memory" }, (res) =>
    applyScopeFilter(res.memories ?? [], filter),
  );
}

/** Memories produced during a specific run. Always shows every actor's row for that run. */
export function useRunMemories(packageId: string | undefined, runId: string | undefined) {
  return usePersistenceQuery(
    packageId,
    `run-memories:${runId ?? ""}`,
    { kind: "memory", runId },
    (res) => res.memories ?? [],
  );
}

/**
 * Checkpoints for an agent.
 *
 * Admins see every actor's checkpoint when no scope filter is applied;
 * members see their own actor + shared. The `filter` is then applied
 * client-side identically to memories.
 */
export function useAgentCheckpoints(
  packageId: string | undefined,
  filter: PersistenceScopeFilter = "all",
) {
  return usePersistenceQuery(
    packageId,
    `agent-checkpoints:${filter}`,
    { kind: "checkpoint" },
    (res) => applyScopeFilter(res.checkpoints ?? [], filter),
  );
}

// --- Mutations -------------------------------------------------------------

export function useDeleteCheckpoint(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (checkpointId: number) => {
      return api(`/agents/${packageId}/persistence/checkpoints/${checkpointId}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent-persistence"] });
    },
    onError: onMutationError,
  });
}
