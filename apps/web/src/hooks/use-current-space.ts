// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect } from "react";
import { useStore } from "zustand";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { ENTER_SPACE_PARAM } from "@appstrate/core/chat-contract";
import {
  linkedSpaceEnterable,
  linkedSpacePath,
  linkedSpaceStep,
  rowSpace,
} from "../lib/across-spaces";
import { isSpaceEnterable } from "../lib/space-lists";
import {
  agentsKeys,
  packageKeys,
  paginatedRunsKeys,
  persistenceKeys,
  runKeys,
  scheduleKeys,
  spansSpaces,
} from "../lib/query-keys";
import { authStore } from "../stores/auth-store";
import { orgStore } from "../stores/org-store";
import { rememberedSpaceKey, spaceStore } from "../stores/space-store";
import { useSpaces } from "./use-spaces";

/** Reactive hook — re-renders when the current space changes; null until one is resolved. */
export function useCurrentSpaceId(): string | null {
  return useStore(spaceStore, (s) => s.id);
}

/**
 * Where a row opens: `path` in the row's own space (`linkedSpacePath`), naming it with
 * `?enterSpace=` when it is not the current one. Every list spanning spaces links its rows so. A
 * row listed in several spaces passes them all and opens in {@link rowSpace}.
 */
export function useSpaceLink(): (
  path: string,
  space: string | readonly string[] | undefined,
) => string {
  const currentSpaceId = useCurrentSpaceId();
  return useCallback(
    (path, space) =>
      linkedSpacePath(
        path,
        typeof space === "object" ? rowSpace(space, currentSpaceId) : space,
        currentSpaceId,
      ),
    [currentSpaceId],
  );
}

// Flat, space-less query-key prefixes dropped on space switch. A key that embeds
// the space (typed-client domains via `useOrgScope`, chat's
// `["chat", "sessions", spaceFilter]`) refetches by itself and must NOT be listed;
// a list across spaces (`spansSpaces`) does not depend on the current one and is kept.
const SPACE_SCOPED_KEYS = new Set<string>(
  [
    packageKeys.all,
    agentsKeys.all,
    persistenceKeys.all,
    runKeys.all,
    runKeys.logsAll,
    paginatedRunsKeys.all,
    scheduleKeys.listAll,
    scheduleKeys.detailAll,
    scheduleKeys.runsAll,
  ].map(([root]) => root),
);

/** Whether a space switch drops this cache entry. Exported for its test. */
export function droppedOnSpaceSwitch(queryKey: readonly unknown[]): boolean {
  const [root] = queryKey;
  return typeof root === "string" && SPACE_SCOPED_KEYS.has(root) && !spansSpaces(queryKey);
}

// The ONE way the current space changes: skipping the cache reset would serve
// rows keyed on the previous space (or on none, right after login) as the new one's.
function selectSpace(queryClient: QueryClient, spaceId: string | null): void {
  if (spaceId === spaceStore.getState().id) return;

  spaceStore.getState().setId(spaceId);

  queryClient.removeQueries({ predicate: (q) => droppedOnSpaceSwitch(q.queryKey) });
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

/** The space a URL's search names with `?enterSpace=`, or null. */
function linkedSpaceIn(search: string): string | null {
  return new URLSearchParams(search).get(ENTER_SPACE_PARAM);
}

/**
 * The only path from the remembered (or linked) space to a scope: none until `GET /api/spaces`
 * proves one enterable, dropped when it stops listing it. A link's `?enterSpace=` is the first
 * candidate, so a cold load scopes once, to it. `search` is the address bar's: under an overlay
 * the page tree's `useLocation` answers the page beneath, which the link does not name. Render
 * inside MainLayout.
 */
export function useSpaceResolver(search: string): void {
  const queryClient = useQueryClient();
  const linked = linkedSpaceIn(search);
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
 * The route side of a link's `?enterSpace=` (`lib/across-spaces.ts`), read by `RouteGate`:
 * `useSpaceResolver` enters the space; this waits until it has, then drops the param — at once
 * when the space cannot be entered or the listing failed. Answers whether the route must still
 * wait: its gate and first reads would otherwise use the previous space.
 */
export function useEnterLinkedSpace(): boolean {
  const { search, hash } = useLocation();
  const navigate = useNavigate();
  const linked = new URLSearchParams(search).get(ENTER_SPACE_PARAM);
  const current = useCurrentSpaceId();
  const { data: spaces, isError } = useSpaces();
  const enterable = linkedSpaceEnterable(spaces, isError, linked);

  useEffect(() => {
    if (linkedSpaceStep(linked, current, enterable) !== "drop") return;
    const next = new URLSearchParams(search);
    next.delete(ENTER_SPACE_PARAM);
    // Navigating with the hash kept: `setSearchParams` would lose it (`#settings` opens a tab).
    navigate({ search: next.toString(), hash }, { replace: true });
  }, [linked, enterable, current, search, hash, navigate]);

  return !!linked;
}
