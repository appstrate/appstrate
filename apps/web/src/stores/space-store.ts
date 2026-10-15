// SPDX-License-Identifier: Apache-2.0

import { createStore } from "zustand/vanilla";
import { isPlainObject } from "@appstrate/core/safe-json";
import { authStore } from "./auth-store";
import { persistedJson } from "./local-storage";
import { getCurrentOrgId } from "./org-store";

const STORAGE_KEY = "appstrate_last_space";

/** By user as well as org: the map outlives the session, and the next account must not inherit it. */
export function rememberedSpaceKey(userId: string, orgId: string): string {
  return `${userId}:${orgId}`;
}

/** Blocked storage keeps the choice for this tab only. */
const persistedRemembered = persistedJson<Record<string, string>>(STORAGE_KEY, (value) =>
  isPlainObject(value) ? (value as Record<string, string>) : {},
);

/** Applies `change` to the PERSISTED map, not this tab's copy: another tab may have written since. */
function writeRemembered(change: (map: Record<string, string>) => void): Record<string, string> {
  const remembered = persistedRemembered.read();
  change(remembered);
  persistedRemembered.write(remembered);
  return remembered;
}

interface SpaceState {
  /**
   * The space every request is scoped to. Starts null: the persisted id may
   * name a space the caller can no longer enter (removed, deleted, a persona
   * without it), so only `useSpaceResolver` promotes it, once proven enterable.
   */
  id: string | null;
  /** Last space per account and org ({@link rememberedSpaceKey}): candidates, never a scope. */
  remembered: Record<string, string>;
  setId: (id: string | null) => void;
  /** Makes `spaceId` the candidate the resolver tries first in `orgId`, without scoping to it. */
  remember: (orgId: string, spaceId: string) => void;
}

/** The persisted map with `spaceId` as the signed-in account's last space in `orgId`; null when signed out. */
function rememberedWith(orgId: string, spaceId: string): Record<string, string> | null {
  const userId = authStore.getState().user?.id;
  if (!userId) return null;
  return writeRemembered((map) => {
    map[rememberedSpaceKey(userId, orgId)] = spaceId;
  });
}

export const spaceStore = createStore<SpaceState>()((set) => ({
  id: null,
  remembered: persistedRemembered.read(),
  setId: (id) => {
    const orgId = getCurrentOrgId();
    const remembered = id && orgId ? rememberedWith(orgId, id) : null;
    set(remembered ? { id, remembered } : { id });
  },
  remember: (orgId, spaceId) => {
    const remembered = rememberedWith(orgId, spaceId);
    if (remembered) set({ remembered });
  },
}));

/** Non-hook accessor for use outside React (e.g. api.ts headers) */
export function getCurrentSpaceId(): string | null {
  return spaceStore.getState().id;
}
