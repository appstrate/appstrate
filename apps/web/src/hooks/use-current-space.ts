// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect } from "react";
import { useStore } from "zustand";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { spaceStore } from "../stores/space-store";
import { useSpaces } from "./use-spaces";

/** Reactive hook — re-renders when the current space changes; null until one is resolved. */
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

interface ResolvableSpace {
  id: string;
  isDefault: boolean;
  access: string;
}

/**
 * The space to stand in: the remembered one while it is still enterable, else
 * the default, else any enterable one; null when none is. Only `member` access
 * enters — scoping to a `closed` space would 403 every space-scoped request.
 */
export function enterableSpaceId(
  remembered: string | null,
  spaces: readonly ResolvableSpace[],
): string | null {
  const enterable = spaces.filter((s) => s.access === "member");
  const pick =
    enterable.find((s) => s.id === remembered) ??
    enterable.find((s) => s.isDefault) ??
    enterable[0];
  return pick?.id ?? null;
}

/**
 * The only path from the remembered space to a scope: requests carry no space
 * until `GET /api/spaces` proves one enterable, and lose it the moment the
 * listing stops listing it. Render inside MainLayout.
 */
export function useSpaceResolver(): void {
  const queryClient = useQueryClient();
  const current = useStore(spaceStore, (s) => s.id);
  const remembered = useStore(spaceStore, (s) => s.remembered);
  const { data: spaces } = useSpaces();

  useEffect(() => {
    if (!spaces) return;
    const next = enterableSpaceId(remembered, spaces);
    if (next !== current) selectSpace(queryClient, next);
  }, [queryClient, spaces, remembered, current]);
}
