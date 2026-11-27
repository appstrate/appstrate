// SPDX-License-Identifier: Apache-2.0

/**
 * The conversation list's date groups the person folded, kept per browser. A blocked or full
 * storage (private mode, quota) never breaks folding: the fold then holds in memory until reload.
 */

import { SESSION_GROUP_KEYS, type SessionGroupKey } from "./session-groups.ts";

export const COLLAPSED_GROUPS_KEY = "appstrate-chat-collapsed-groups";

const GROUP_KEYS: ReadonlySet<string> = new Set(SESSION_GROUP_KEYS);

/** The stored folded keys; garbage, unknown keys and an unreadable storage read as « none folded ». */
export function readCollapsedGroups(): ReadonlySet<SessionGroupKey> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY) ?? "[]");
    return new Set(
      Array.isArray(stored)
        ? stored.filter(
            (key): key is SessionGroupKey => typeof key === "string" && GROUP_KEYS.has(key),
          )
        : [],
    );
  } catch {
    return new Set();
  }
}

/** `current` with `key` folded or unfolded, written through to the storage when it accepts it. */
export function setGroupFolded(
  current: ReadonlySet<SessionGroupKey>,
  key: SessionGroupKey,
  folded: boolean,
): ReadonlySet<SessionGroupKey> {
  const next = new Set(current);
  if (folded) next.add(key);
  else next.delete(key);
  try {
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...next]));
  } catch {
    // Private mode or a full quota: the fold holds until the page reloads.
  }
  return next;
}
