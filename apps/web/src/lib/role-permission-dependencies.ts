// SPDX-License-Identifier: Apache-2.0

/**
 * The role editor's dependent permissions (issue #1513). The server refuses a role missing
 * a read; the picker applies the vocabulary's `requires_one_of` before the save instead.
 */

import type { components } from "../api/client";

export type RoleVocabularyEntry =
  components["schemas"]["RoleVocabularyGroup"]["permissions"][number];

/** `selected` with `entry` flipped; ticking it also ticks its read when none is held yet. */
export function togglePermission(
  selected: ReadonlySet<string>,
  entry: RoleVocabularyEntry,
): Set<string> {
  const next = new Set(selected);
  if (next.delete(entry.permission)) return next;
  next.add(entry.permission);
  const [read] = entry.requires_one_of;
  if (read && !entry.requires_one_of.some((grant) => next.has(grant))) next.add(read);
  return next;
}

/** Each selected read that a selected entry depends on alone, mapped to those entries. */
export function lockedReads(
  selected: ReadonlySet<string>,
  entries: readonly RoleVocabularyEntry[],
): Map<string, RoleVocabularyEntry[]> {
  const locked = new Map<string, RoleVocabularyEntry[]>();
  for (const entry of entries) {
    if (!selected.has(entry.permission)) continue;
    const [read, ...others] = entry.requires_one_of.filter((grant) => selected.has(grant));
    if (!read || others.length > 0) continue;
    locked.set(read, [...(locked.get(read) ?? []), entry]);
  }
  return locked;
}
