// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { useStore } from "zustand";
import { useQueryClient } from "@tanstack/react-query";
import { spaceStore, getCurrentSpaceId } from "../stores/space-store";
import { useSpaces } from "./use-spaces";
import { useAutoSelect } from "./use-auto-select";

// Re-export non-hook accessor
export { getCurrentSpaceId };

/** Reactive hook — re-renders when the current space changes. */
export function useCurrentSpaceId(): string | null {
  return useStore(spaceStore, (s) => s.id);
}

/**
 * Space-scoped PINNED query-key prefixes — invalidated on space switch.
 * Only the run/schedule/package domains that keep flat legacy keys
 * (`["runs", …]`, etc.) need listing here. Typed-client domains (api-keys,
 * end-users, integrations, notifications, …) embed `X-Space-Id` in their
 * `[method, path, init]` key via `useOrgScope`, so switching spaces yields a new
 * key and refetches automatically — they must NOT be listed (their `queryKey[0]`
 * is the method string, never these prefixes).
 */
const SPACE_SCOPED_KEYS = new Set([
  "packages",
  "agents",
  "agent-persistence",
  "agent-model",
  "agent-proxy",
  "runs",
  "run",
  "run-logs",
  "paginated-runs",
  "schedules",
  "schedule",
  "schedule-runs",
  "version-detail",
  "package-versions",
  "version-info",
]);

/**
 * Hook that returns a `switchSpace` function.
 * Switches the current space and invalidates space-scoped caches.
 */
export function useSpaceSwitcher() {
  const queryClient = useQueryClient();

  const switchSpace = useCallback(
    (spaceId: string) => {
      const current = spaceStore.getState().id;
      if (spaceId === current) return;

      spaceStore.getState().setId(spaceId);

      // Invalidate all space-scoped queries so they refetch with the new X-Space-Id
      queryClient.removeQueries({
        predicate: (q) => {
          const key = q.queryKey[0];
          return typeof key === "string" && SPACE_SCOPED_KEYS.has(key);
        },
      });
    },
    [queryClient],
  );

  return { switchSpace };
}

/**
 * Resolver — ensures `currentSpaceId` is always set.
 * If null, fetches spaces and auto-selects the default one.
 * Must be called inside a component rendered within MainLayout.
 */
export function useSpaceResolver(): void {
  const currentSpaceId = useStore(spaceStore, (s) => s.id);
  const { data: spaces } = useSpaces();

  const setId = useCallback((id: string) => spaceStore.getState().setId(id), []);
  const findDefault = useCallback(
    (items: { id: string; isDefault: boolean }[]) => items.find((s) => s.isDefault),
    [],
  );

  useAutoSelect(spaces, currentSpaceId, setId, findDefault);
}
