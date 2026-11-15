// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect } from "react";
import { useStore } from "zustand";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { ENTER_SPACE_PARAM, linkedSpaceStep } from "../lib/across-spaces";
import {
  agentModelKeys,
  agentProxyKeys,
  agentsKeys,
  packageKeys,
  paginatedRunsKeys,
  persistenceKeys,
  runKeys,
  scheduleKeys,
  versionKeys,
} from "../lib/query-keys";
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
const SPACE_SCOPED_KEYS = new Set<string>(
  [
    packageKeys.all,
    agentsKeys.all,
    persistenceKeys.all,
    agentModelKeys.all,
    agentProxyKeys.all,
    runKeys.all,
    runKeys.logsAll,
    paginatedRunsKeys.all,
    scheduleKeys.listAll,
    scheduleKeys.detailAll,
    scheduleKeys.runsAll,
    versionKeys.detailAll,
    versionKeys.listAll,
    versionKeys.infoAll,
  ].map(([root]) => root),
);

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

/** Returns a `switchSpace` function that also drops space-scoped caches. */
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

/** Only `member` access enters: scoping to a listed `access: "none"` space 403s every request. */
export function isSpaceEnterable(space: { access: string }): boolean {
  return space.access === "member";
}

/**
 * The space to stand in: the one a link names (`?enterSpace=`) while enterable, else the
 * remembered one while enterable, else default, else a team space (a guest has no default),
 * else the personal one; null when none is.
 */
export function enterableSpaceId(
  remembered: string | null,
  spaces: readonly ResolvableSpace[],
  linked: string | null = null,
): string | null {
  const enterable = spaces.filter(isSpaceEnterable);
  const pick =
    enterable.find((s) => s.id === linked) ??
    enterable.find((s) => s.id === remembered) ??
    enterable.find((s) => s.isDefault) ??
    enterable.find((s) => !s.personal) ??
    enterable[0];
  return pick?.id ?? null;
}

/**
 * The only path from the remembered (or linked) space to a scope: none until `GET /api/spaces`
 * proves one enterable, dropped when it stops listing it. A link's `?enterSpace=` is the first
 * candidate, so a cold load scopes once, to it. Render inside MainLayout (router context).
 */
export function useSpaceResolver(): void {
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const linked = params.get(ENTER_SPACE_PARAM);
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
    const next = enterableSpaceId(remembered, spaces, linked);
    // `setId` remembers it: once the param is dropped, the remembered space keeps it.
    if (next !== current) selectSpace(queryClient, next);
  }, [queryClient, spaces, remembered, linked, current]);
}

/**
 * The page side of a link's `?enterSpace=` (`lib/across-spaces.ts`): `useSpaceResolver` enters
 * the space; this waits until it has, then drops the param — at once when the space cannot be
 * entered or the listing failed. Answers whether the page must still wait: its first reads would
 * otherwise go out scoped to the previous space.
 */
export function useEnterLinkedSpace(): boolean {
  const [params, setParams] = useSearchParams();
  const linked = params.get(ENTER_SPACE_PARAM);
  const current = useCurrentSpaceId();
  const { data: spaces, isError } = useSpaces();
  // Undefined until the listing answers; a failed listing cannot prove the space enterable.
  const enterable = spaces
    ? spaces.some((s) => s.id === linked && isSpaceEnterable(s))
    : isError
      ? false
      : undefined;

  useEffect(() => {
    if (linkedSpaceStep(linked, current, enterable) !== "drop") return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(ENTER_SPACE_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [linked, enterable, current, setParams]);

  return !!linked;
}
