// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect } from "react";
import { useStore } from "zustand";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { authStore } from "../stores/auth-store";
import { orgStore } from "../stores/org-store";
import { rememberedSpaceKey, spaceStore } from "../stores/space-store";
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
  personal: boolean;
  access: string;
}

/**
 * Whether the caller may stand in a listed space. Only `member` access enters:
 * a `closed` space or an orphaned personal one is listed with `access: "none"`,
 * and scoping to it would 403 every space-scoped request.
 */
export function isSpaceEnterable(space: { access: string }): boolean {
  return space.access === "member";
}

/**
 * The space to stand in: the remembered one while it is still enterable, else
 * the default, else a team space, else the caller's personal one; null when
 * none is. Team before personal whatever the listing order: a guest holds no
 * role in the default space and must land in the team space they were invited
 * to, not in an empty "Mon espace".
 */
export function enterableSpaceId(
  remembered: string | null,
  spaces: readonly ResolvableSpace[],
): string | null {
  const enterable = spaces.filter(isSpaceEnterable);
  const pick =
    enterable.find((s) => s.id === remembered) ??
    enterable.find((s) => s.isDefault) ??
    enterable.find((s) => !s.personal) ??
    enterable[0];
  return pick?.id ?? null;
}

/**
 * The only path from the space this account remembered for the current
 * organization to a scope: requests carry no space until `GET /api/spaces`
 * proves one enterable, and lose it the moment the listing stops listing it.
 * Render inside MainLayout.
 */
export function useSpaceResolver(): void {
  const queryClient = useQueryClient();
  const current = useStore(spaceStore, (s) => s.id);
  const orgId = useStore(orgStore, (s) => s.id);
  const userId = useStore(authStore, (s) => s.user?.id);
  const remembered = useStore(
    spaceStore,
    (s) => (userId && orgId && s.remembered[rememberedSpaceKey(userId, orgId)]) || null,
  );
  const { data: spaces } = useSpaces();

  useEffect(() => {
    if (!spaces) return;
    const next = enterableSpaceId(remembered, spaces);
    if (next !== current) selectSpace(queryClient, next);
  }, [queryClient, spaces, remembered, current]);
}
