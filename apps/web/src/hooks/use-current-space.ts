// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo } from "react";
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
 * Only the run/schedule/package domains that keep flat legacy keys
 * (`["runs", …]`, etc.) need listing here. Typed-client domains (api-keys,
 * end-users, integrations, notifications, …) embed `X-Space-Id` in their
 * `[method, path, init]` key via `useOrgScope`, so switching spaces yields a new
 * key and refetches automatically — they must NOT be listed (their `queryKey[0]`
 * is the method string, never these prefixes).
 */
const SPACE_SCOPED_KEYS = new Set([
  // Chat sessions are space-scoped rows (`chat_sessions.space_id`), and the
  // chat UI's keys are flat (`["chat", "sessions"]`, `["chat", "session", id]`)
  // rather than typed-client tuples, so they need listing here.
  "chat",
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
function selectSpace(queryClient: QueryClient, spaceId: string): void {
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
 * Resolver — ensures `currentSpaceId` is always set.
 * If null, fetches spaces and auto-selects the default enterable one.
 * Must be called inside a component rendered within MainLayout.
 *
 * Only `access: "member"` spaces are candidates: a `closed` space is listed so
 * the caller knows it exists, not so they can be dropped into it — pinning one
 * would make every space-scoped request 403.
 */
export function useSpaceResolver(): void {
  const currentSpaceId = useStore(spaceStore, (s) => s.id);
  const { data: spaces } = useSpaces();
  const { switchSpace } = useSpaceSwitcher();

  const enterable = useMemo(() => spaces?.filter((s) => s.access === "member"), [spaces]);
  const findDefault = useCallback(
    (items: { id: string; isDefault: boolean }[]) => items.find((s) => s.isDefault),
    [],
  );

  useAutoSelect(enterable, currentSpaceId, switchSpace, findDefault);
}
