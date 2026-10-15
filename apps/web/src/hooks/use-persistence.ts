// SPDX-License-Identifier: Apache-2.0

/** Persistence hooks (pinned slots + memories). A "pinned slot" is any non-null `key` in `package_persistence`, including the carry-over `checkpoint`. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentMemoryItem, AgentPinnedSlotItem } from "@appstrate/shared-types";
import { client } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { useCurrentOrgId } from "./use-org";
import { useCurrentSpaceId } from "./use-current-space";
import { usePermissions } from "./use-permissions";
import { persistenceKeys } from "../lib/query-keys";

interface PersistenceResponse {
  pinned?: AgentPinnedSlotItem[];
  memories?: AgentMemoryItem[];
}

/** One subscription against `/persistence`; the stable `scopeTag` keeps run-level and agent-level views from sharing a cache slot. */
function usePersistenceQuery<T>(
  packageId: string | undefined,
  scopeTag: string,
  query: { kind: "pinned" | "memory"; runId?: string },
  pick: (res: PersistenceResponse) => T,
) {
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  const { can } = usePermissions();
  return useQuery({
    // Key pinned: use-mutations and the space-switch reset invalidate by its prefix.
    queryKey: persistenceKeys.list(scopeTag, orgId, spaceId, packageId, query),
    queryFn: async () => {
      const { scope, name } = splitPackageRef(packageId!);
      const { data } = await client.GET("/api/agents/{scope}/{name}/persistence", {
        params: { path: { scope, name }, query },
      });
      return pick(data ?? {});
    },
    // Not implied by any page that shows memory (agent or run detail).
    enabled: can("persistence:read") && !!orgId && !!spaceId && !!packageId,
  });
}

/** Every memory row the caller may read for an agent. */
export function useAgentMemories(packageId: string | undefined) {
  return usePersistenceQuery(
    packageId,
    "agent-memories",
    { kind: "memory" },
    (res) => res.memories ?? [],
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

/** Pinned slots for an agent. Admins see every actor's; members their own and the shared ones. */
export function useAgentPinned(packageId: string | undefined) {
  return usePersistenceQuery(
    packageId,
    "agent-pinned",
    { kind: "pinned" },
    (res) => res.pinned ?? [],
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
      qc.invalidateQueries({ queryKey: persistenceKeys.all });
    },
  });
}
