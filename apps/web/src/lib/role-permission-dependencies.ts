// SPDX-License-Identifier: Apache-2.0

// The server refuses a role missing a read; the picker applies `requires_one_of` before the save.

import type { components } from "../api/client";
import { permissionLabel } from "./permission-labels";

export type RoleVocabularyEntry =
  components["schemas"]["RoleVocabularyGroup"]["permissions"][number];

/** `selected` plus the read each selected entry needs; the first of `requires_one_of` is added when none is held. */
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

/** What a locked read's note names: its dependents, by their labels. */
export function dependentsLabel(
  dependents: readonly RoleVocabularyEntry[],
  t: (key: string) => string,
): string {
  return dependents.map((dependent) => permissionLabel(dependent.permission, t)).join(", ");
}
