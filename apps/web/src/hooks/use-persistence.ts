// SPDX-License-Identifier: Apache-2.0

/** Persistence hooks (pinned slots + memories). A "pinned slot" is any non-null `key` in `package_persistence`, including the carry-over `checkpoint`. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentMemoryItem, AgentPinnedSlotItem } from "@appstrate/shared-types";
import { client } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { spaceHeader } from "../lib/scoping-headers";
import { useListScope } from "./use-org-scope";
import { usePermissions } from "./use-permissions";
import { persistenceKeys } from "../lib/query-keys";

interface PersistenceResponse {
  pinned?: AgentPinnedSlotItem[];
  memories?: AgentMemoryItem[];
}

interface PersistenceReach {
  /** Every space the reader reaches instead of the current one (`GET /api/orgs/{orgId}/agents/{scope}/{name}/persistence`): each row names its `spaceId`. */
  spanning?: boolean;
}

/** An agent's persistence in the current space, or every space's of `acrossOrgId`. Exported for its test. */
export async function fetchAgentPersistence(
  packageId: string,
  acrossOrgId: string | null,
  query: { kind: "pinned" | "memory"; runId?: string },
): Promise<PersistenceResponse> {
  const { scope, name } = splitPackageRef(packageId);
  const { data } = acrossOrgId
    ? await client.GET("/api/orgs/{orgId}/agents/{scope}/{name}/persistence", {
        params: { path: { orgId: acrossOrgId, scope, name }, query },
      })
    : await client.GET("/api/agents/{scope}/{name}/persistence", {
        params: { path: { scope, name }, query },
      });
  return data ?? {};
}

/** One subscription against `/persistence`; the stable `scopeTag` keeps run-level and agent-level views from sharing a cache slot. */
function usePersistenceQuery<T>(
  packageId: string | undefined,
  scopeTag: string,
  query: { kind: "pinned" | "memory"; runId?: string },
  pick: (res: PersistenceResponse) => T,
  spanning = false,
) {
  const { can } = usePermissions();
  // Not implied by any page that shows memory (agent or run detail).
  const scope = useListScope(spanning, can("persistence:read"));
  return useQuery({
    // Key pinned: use-mutations and the space-switch reset invalidate by its prefix.
    queryKey: persistenceKeys.list(scope.orgId, scope.keySpace, scopeTag, packageId, query),
    queryFn: async () => pick(await fetchAgentPersistence(packageId!, scope.acrossOrgId, query)),
    enabled: scope.enabled && !!packageId,
    refetchInterval: scope.refetchInterval,
  });
}

/**
 * Memories for an agent. Visibility is the same for both halves, here and on
 * a run: a `persistence:delete` holder sees every actor's; others their own
 * and the shared ones — judged in each row's space when `spanning`.
 */
export function useAgentMemories(
  packageId: string | undefined,
  { spanning }: PersistenceReach = {},
) {
  return usePersistenceQuery(
    packageId,
    "agent-memories",
    { kind: "memory" },
    (res) => res.memories ?? [],
    spanning,
  );
}

/** Memories produced during a specific run — same visibility as `useAgentMemories`. */
export function useRunMemories(packageId: string | undefined, runId: string | undefined) {
  return usePersistenceQuery(
    packageId,
    `run-memories:${runId ?? ""}`,
    { kind: "memory", runId },
    (res) => res.memories ?? [],
  );
}

/** Pinned slots for an agent — same visibility as `useAgentMemories`. */
export function useAgentPinned(packageId: string | undefined, { spanning }: PersistenceReach = {}) {
  return usePersistenceQuery(
    packageId,
    "agent-pinned",
    { kind: "pinned" },
    (res) => res.pinned ?? [],
    spanning,
  );
}

/** Pinned slots written during a specific run — same visibility as `useAgentMemories`. */
export function useRunPinned(packageId: string | undefined, runId: string | undefined) {
  return usePersistenceQuery(
    packageId,
    `run-pinned:${runId ?? ""}`,
    { kind: "pinned", runId },
    (res) => res.pinned ?? [],
  );
}

// --- Mutations -------------------------------------------------------------

/** One row of the memory list, deleted in its own space (`spaceId`; the current space when absent). */
export interface PersistenceRowRef {
  kind: "pinned" | "archive";
  id: number;
  spaceId?: string;
}

/** Deletes one pinned slot or memory of `packageId`, in the row's space. */
export function useDeletePersistenceRow(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ kind, id, spaceId }: PersistenceRowRef) => {
      const { scope, name } = splitPackageRef(packageId);
      if (kind === "pinned") {
        await client.DELETE("/api/agents/{scope}/{name}/persistence/pinned/{id}", {
          params: { path: { scope, name, id } },
          ...spaceHeader(spaceId),
        });
      } else {
        await client.DELETE("/api/agents/{scope}/{name}/persistence/memories/{id}", {
          params: { path: { scope, name, id } },
          ...spaceHeader(spaceId),
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: persistenceKeys.all });
    },
  });
}

/**
 * Deletes every memory of `packageId` in ONE space: `mutate(spaceId)`. Memory is kept per space,
 * so the caller names the space — from « Tous les espaces », the one the reader picked.
 */
export function useDeleteAgentMemories(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (spaceId: string) => {
      const { data } = await client.DELETE("/api/agents/{scope}/{name}/persistence", {
        params: { path: splitPackageRef(packageId), query: { kind: "memory" } },
        ...spaceHeader(spaceId),
      });
      return data!;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: persistenceKeys.all });
    },
  });
}
