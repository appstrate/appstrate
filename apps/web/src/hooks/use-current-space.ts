// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo } from "react";
import { useStore } from "zustand";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { spaceStore, getCurrentSpaceId } from "../stores/space-store";
import { useSpaces } from "./use-spaces";
import { useAutoSelect } from "./use-auto-select";

// Re-export non-hook accessor
export { getCurrentSpaceId };

/** Reactive hook — re-renders when the current space changes. */
export function useCurrentSpaceId(): string | null {
  return useStore(spaceStore, (s) => s.id);
}

// Flat, space-less query-key prefixes dropped on space switch. A key that embeds
// the space (typed-client domains via `useOrgScope`, chat's
// `["chat", "sessions", spaceId]`) refetches by itself and must NOT be listed.
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

// The ONE way the current space changes: skipping the cache reset would serve
// rows keyed on the previous space (or on none, right after login) as the new one's.
function selectSpace(queryClient: QueryClient, spaceId: string | null): void {
  if (spaceId === spaceStore.getState().id) return;

  spaceStore.getState().setId(spaceId);

  queryClient.removeQueries({
    predicate: (q) => {
      const key = q.queryKey[0];
      return typeof key === "string" && SPACE_SCOPED_KEYS.has(key);
    },
  });
}

/**
 * Hook that returns a `switchSpace` function.
 * Switches the current space and invalidates space-scoped caches.
 */
export function useSpaceSwitcher() {
  const queryClient = useQueryClient();

  const switchSpace = useCallback(
    (spaceId: string) => selectSpace(queryClient, spaceId),
    [queryClient],
  );

  return { switchSpace };
}

/**
 * With no enterable space `useAutoSelect` has nothing to replace a stale id with,
 * and it would keep riding on `X-Space-Id`, 403-ing every space-scoped request.
 */
export function dropUnenterableSpace(
  queryClient: QueryClient,
  enterable: { id: string }[] | undefined,
  currentSpaceId: string | null,
): void {
  if (enterable?.length === 0 && currentSpaceId) selectSpace(queryClient, null);
}

/**
 * Keeps `currentSpaceId` on an enterable (`access: "member"`) space or null —
 * pinning a `closed` space would 403 every space-scoped request. Render inside MainLayout.
 */
export function useSpaceResolver(): void {
  const queryClient = useQueryClient();
  const currentSpaceId = useStore(spaceStore, (s) => s.id);
  const { data: spaces } = useSpaces();
  const { switchSpace } = useSpaceSwitcher();

  const enterable = useMemo(() => spaces?.filter((s) => s.access === "member"), [spaces]);
  const findDefault = useCallback(
    (items: { id: string; isDefault: boolean }[]) => items.find((s) => s.isDefault),
    [],
  );

  useEffect(
    () => dropUnenterableSpace(queryClient, enterable, currentSpaceId),
    [queryClient, enterable, currentSpaceId],
  );
  useAutoSelect(enterable, currentSpaceId, switchSpace, findDefault);
}
