// SPDX-License-Identifier: Apache-2.0

import { createStore } from "zustand/vanilla";
import { authStore } from "./auth-store";
import { getCurrentOrgId } from "./org-store";

const STORAGE_KEY = "appstrate_last_space";

/** By user as well as org: the map outlives the session, and the next account must not inherit it. */
export function rememberedSpaceKey(userId: string, orgId: string): string {
  return `${userId}:${orgId}`;
}

function readRemembered(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

/** Applies `change` to the PERSISTED map, not this tab's copy: another tab may have written since. */
function writeRemembered(change: (map: Record<string, string>) => void): Record<string, string> {
  const remembered = readRemembered();
  change(remembered);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(remembered));
  } catch {
    // Storage blocked: the choice holds for this tab only.
  }
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
}

export const spaceStore = createStore<SpaceState>()((set) => ({
  id: null,
  remembered: readRemembered(),
  setId: (id) => {
    const orgId = getCurrentOrgId();
    const userId = authStore.getState().user?.id;
    if (!id || !orgId || !userId) {
      set({ id });
      return;
    }
    set({
      id,
      remembered: writeRemembered((map) => {
        map[rememberedSpaceKey(userId, orgId)] = id;
      }),
    });
  },
}));

/** Non-hook accessor for use outside React (e.g. api.ts headers) */
export function getCurrentSpaceId(): string | null {
  return spaceStore.getState().id;
}
