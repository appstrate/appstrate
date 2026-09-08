// SPDX-License-Identifier: Apache-2.0

/** One `GET /api/roles/vocabulary` group, as the editor consumes it. */
type VocabularyGroup = { resource: string; permissions: { permission: string }[] };

/**
 * Selected permissions the running platform cannot name — a module that
 * contributed them is no longer loaded.
 *
 * They stay selected on open rather than being dropped: a role is what it says
 * it is, and silently rewriting it the moment someone opens the editor is a
 * change nobody asked for. But the write route validates against this same
 * vocabulary and refuses the unknown string with a 400, so leaving them
 * invisible made the role unfixable — every save resent them, and no control
 * could take them out.
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
