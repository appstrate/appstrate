// SPDX-License-Identifier: Apache-2.0

/**
 * Unified persistence hooks (ADR-011 + ADR-013) — pinned slots + memories.
 *
 * Reads go through `GET /agents/:id/persistence` with `kind` and optional
 * `runId` filters. The same `usePersistenceQuery` factor backs every read
 * hook so cache keys, scope-filter logic, and `enabled` semantics stay in
 * one place.
 *
 * "Pinned slot" = any non-null `key` in `package_persistence`. Includes the
 * carry-over slot (`key="checkpoint"`) plus Letta-style named blocks
 * written by `pin({ key, content })`.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AgentMemoryItem,
  AgentPinnedSlotItem,
  PersistenceActorType,
} from "@appstrate/shared-types";
import { api, buildQs } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import { onMutationError } from "./use-mutations";
import type { PersistenceScopeFilter } from "../components/persistence/scope-filter";

type ServerMemory = Omit<AgentMemoryItem, "actorType" | "actorId"> & {
  actorType: PersistenceActorType;
  actorId: string | null;
};

interface PersistenceResponse {
  pinned?: AgentPinnedSlotItem[];
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
      const res = await api<PersistenceResponse>(
        `/agents/${packageId}/persistence${buildQs(params)}`,
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
 * Pinned slots for an agent (any non-null `key`).
 *
 * Admins see every actor's slot when no scope filter is applied; members see
 * their own actor + shared. The `filter` is then applied client-side
 * identically to memories.
 */
export function useAgentPinned(
  packageId: string | undefined,
  filter: PersistenceScopeFilter = "all",
) {
  return usePersistenceQuery(packageId, `agent-pinned:${filter}`, { kind: "pinned" }, (res) =>
    applyScopeFilter(res.pinned ?? [], filter),
  );
}

/** Pinned slots written during a specific run. */
export function useRunPinned(packageId: string | undefined, runId: string | undefined) {
  return usePersistenceQuery(
    packageId,
    `run-pinned:${runId ?? ""}`,
    { kind: "pinned", runId },
    (res) => res.pinned ?? [],
  );
}

// --- Mutations -------------------------------------------------------------

export function useDeletePinnedSlot(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (slotId: number) => {
      return api(`/agents/${packageId}/persistence/pinned/${slotId}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent-persistence"] });
    },
    onError: onMutationError,
  });
}
