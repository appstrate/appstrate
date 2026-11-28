// SPDX-License-Identifier: Apache-2.0

/**
 * The conversation list's date groups the person folded, kept per browser. A blocked or full
 * storage (private mode, quota) never breaks folding: the fold then holds in memory until reload.
 */

import { LOCAL_STORAGE_KEYS, createLocalStore, jsonCodec } from "@appstrate/ui/local-storage";
import { SESSION_GROUP_KEYS, type SessionGroupKey } from "./session-groups.ts";

const GROUP_KEYS: ReadonlySet<string> = new Set(SESSION_GROUP_KEYS);

/** Garbage and unknown keys read as « none folded ». */
const stored = createLocalStore(
  LOCAL_STORAGE_KEYS.chatCollapsedGroups,
  jsonCodec((value): SessionGroupKey[] =>
    Array.isArray(value)
      ? value.filter(
          (key): key is SessionGroupKey => typeof key === "string" && GROUP_KEYS.has(key),
        )
      : [],
  ),
);

export function readCollapsedGroups(): ReadonlySet<SessionGroupKey> {
  return new Set(stored.read());
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
  stored.write([...next]);
  return next;
}
