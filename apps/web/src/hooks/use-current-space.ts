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

/**
 * Space-scoped PINNED query-key prefixes — invalidated on space switch.
 * Only the run/schedule/package domains, whose keys are flat AND carry no space
 * (`["runs", …]`, etc.), need listing here. A key that already carries the space
 * — every typed-client domain, which embeds `X-Space-Id` in its
 * `[method, path, init]` key via `useOrgScope`, and the chat module's
 * `["chat", "sessions", spaceId]` — yields a new key on switch and refetches by
 * itself, so it must NOT be listed.
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
 * The ONE way the current space changes.
 *
 * Both callers go through it — the user picking a space in the switcher and the
 * resolver picking one at boot — because a selection that skips the cache reset
 * leaves entries keyed on the previous space (or on no space at all, right
 * after login) to be served as if they belonged to the new one.
 */
function selectSpace(queryClient: QueryClient, spaceId: string | null): void {
  if (spaceId === spaceStore.getState().id) return;

  spaceStore.getState().setId(spaceId);

  // Drop every space-scoped query so it refetches with the new X-Space-Id
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
 * Forget a persisted space when NOTHING is enterable any more — the caller's
 * memberships were removed, or a preview sees less than they do. With at least
 * one enterable space `useAutoSelect` replaces a stale id itself; with none it
 * has nothing to pick, and the stale id would keep riding on `X-Space-Id`,
 * 403-ing every space-scoped request while `usePermissions()` reports ready.
 * Goes through `selectSpace` so the previous space's cached rows go with it.
 */
export function dropUnenterableSpace(
  queryClient: QueryClient,
  enterable: { id: string }[] | undefined,
  currentSpaceId: string | null,
): void {
  if (enterable?.length === 0 && currentSpaceId) selectSpace(queryClient, null);
}

/**
 * Resolver — ensures `currentSpaceId` names a space the caller can enter, or
 * nothing. Must be called inside a component rendered within MainLayout.
 *
 * Only `access: "member"` spaces are candidates: a `closed` space is listed so
 * the caller knows it exists, not so they can be dropped into it — pinning one
 * would make every space-scoped request 403.
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
