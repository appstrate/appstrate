// SPDX-License-Identifier: Apache-2.0

/** One `GET /api/roles/vocabulary` group, as the editor consumes it. */
type VocabularyGroup = { resource: string; permissions: { permission: string }[] };

/**
 * Selected permissions the running platform cannot name — a module that
 * contributed them is no longer loaded.
 *
 * They stay selected on open rather than being dropped: a role is what it says
 * it is, and silently rewriting it the moment someone opens the editor is a
 * change nobody asked for. They are named so the editor can offer a control
 * that removes them: the write route validates against this same vocabulary and
 * refuses an unknown string with a 400, so a selection with no control of its
 * own is one no save can clear.
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
