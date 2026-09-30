// SPDX-License-Identifier: Apache-2.0

/**
 * The role editor's dependent permissions (issue #1513). The server refuses a role missing
 * a read; the picker applies the vocabulary's `requires_one_of` before the save instead.
 */

import type { components } from "../api/client";

export type RoleVocabularyEntry =
  components["schemas"]["RoleVocabularyGroup"]["permissions"][number];

/**
 * `selected` with the read of every selected entry held: what ticking an action adds, and
 * what unticking a read a selected action depends on alone cannot remove. The first of
 * `requires_one_of` is the one added, when none is held yet.
 */
export function withRequiredReads(
  selected: ReadonlySet<string>,
  entries: readonly RoleVocabularyEntry[],
): Set<string> {
  const next = new Set(selected);
  for (const entry of entries) {
    if (!next.has(entry.permission)) continue;
    const [read] = entry.requires_one_of;
    if (read && !entry.requires_one_of.some((grant) => next.has(grant))) next.add(read);
  }
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

/**
 * What a locked read's note names: its dependents' actions, and in full a dependent of
 * another resource (`agents:run` holding a runs read).
 */
export function dependentsLabel(read: string, dependents: readonly RoleVocabularyEntry[]): string {
  const resource = read.slice(0, read.indexOf(":") + 1);
  return dependents
    .map((dependent) =>
      dependent.permission.startsWith(resource) ? dependent.action : dependent.permission,
    )
    .join(", ");
}
