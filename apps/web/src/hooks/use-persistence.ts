// SPDX-License-Identifier: Apache-2.0

/**
 * Unified persistence hooks — pinned slots + memories.
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
import { client } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import { onMutationError } from "./use-mutations";
import type { PersistenceScopeFilter } from "../components/persistence/scope-filter";

interface PersistenceResponse {
  pinned?: AgentPinnedSlotItem[];
  memories?: AgentMemoryItem[];
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
  query: { kind: "pinned" | "memory"; runId?: string },
  pick: (res: PersistenceResponse) => T,
) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    // Key pinned to the legacy "agent-persistence" prefix: use-mutations and
    // the app-switch reset invalidate by that prefix.
    queryKey: ["agent-persistence", scopeTag, orgId, applicationId, packageId, query],
    queryFn: async () => {
      const { scope, name } = splitPackageRef(packageId!);
      const { data } = await client.GET("/api/agents/{scope}/{name}/persistence", {
        params: { path: { scope, name }, query },
      });
      // The spec marks row fields optional; the server always returns the
      // full wire DTOs (AgentPinnedSlotItem / AgentMemoryItem).
      return pick((data ?? {}) as PersistenceResponse);
    },
    enabled: !!orgId && !!applicationId && !!packageId,
  });
}

function applyScopeFilter<T extends { actor_type: PersistenceActorType }>(
  rows: T[],
  filter: PersistenceScopeFilter,
): T[] {
  if (filter === "shared") return rows.filter((r) => r.actor_type === "shared");
  if (filter === "mine") return rows.filter((r) => r.actor_type !== "shared");
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
      const { scope, name } = splitPackageRef(packageId);
      await client.DELETE("/api/agents/{scope}/{name}/persistence/pinned/{id}", {
        params: { path: { scope, name, id: slotId } },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent-persistence"] });
    },
    onError: onMutationError,
  });
}
