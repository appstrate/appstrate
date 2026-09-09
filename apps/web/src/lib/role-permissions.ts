// SPDX-License-Identifier: Apache-2.0

type VocabularyGroup = { resource: string; permissions: { permission: string }[] };

/**
 * Selected permissions the platform cannot name (their module is unloaded). They
 * stay selected, and are named so the editor can offer a control that removes
 * them — the write route 400s on an unknown string, so no save can clear one.
 */
export function unavailablePermissions(
  selected: ReadonlySet<string>,
  vocabulary: readonly VocabularyGroup[],
): string[] {
  const known = new Set(
    vocabulary.flatMap((group) => group.permissions.map((entry) => entry.permission)),
  );
  return [...selected].filter((permission) => !known.has(permission)).sort();
}
