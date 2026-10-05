// SPDX-License-Identifier: Apache-2.0

import { createStore } from "zustand/vanilla";
import { getCurrentOrgId } from "./org-store";

const STORAGE_KEY = "appstrate_last_space_by_org";

function readRemembered(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

/**
 * Apply `change` to the PERSISTED map, not to this tab's copy of it: another
 * tab may have remembered a space in another organization since this one loaded.
 */
function writeRemembered(change: (map: Record<string, string>) => void): Record<string, string> {
  const remembered = readRemembered();
  change(remembered);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(remembered));
  } catch {
    // Storage blocked (private mode, sandboxed iframe): the choice holds for
    // this tab, it just does not survive a reload.
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
  /**
   * The last space chosen in each organization, persisted across reloads, org
   * switches and sign-outs — candidates, never a scope: an id is only ever
   * promoted to `id` after `GET /api/spaces` lists it as enterable for whoever
   * is signed in, so one left behind by another account selects nothing.
   */
  remembered: Record<string, string>;
  /** `null` leaves the scope (org switch, sign-out) without forgetting the choice. */
  setId: (id: string | null) => void;
  /** Drop what was remembered for an organization the caller left or deleted. */
  forgetOrg: (orgId: string) => void;
}

export const spaceStore = createStore<SpaceState>()((set) => ({
  id: null,
  remembered: readRemembered(),
  setId: (id) => {
    const orgId = getCurrentOrgId();
    if (!id || !orgId) {
      set({ id });
      return;
    }
    set({
      id,
      remembered: writeRemembered((map) => {
        map[orgId] = id;
      }),
    });
  },
  forgetOrg: (orgId) =>
    set({
      remembered: writeRemembered((map) => {
        delete map[orgId];
      }),
    }),
}));

/** Non-hook accessor for use outside React (e.g. api.ts headers) */
export function getCurrentSpaceId(): string | null {
  return spaceStore.getState().id;
}
