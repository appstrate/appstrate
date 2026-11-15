// SPDX-License-Identifier: Apache-2.0

/**
 * The predicate of a stored agent manifest that still carries `runtime_tools`,
 * a field nothing reads. The boot guard (`assertRuntimeToolsMigrated`) counts
 * it; `scripts/migration/0053-migrate-runtime-tools.ts` removes it. Pure SQL
 * text, no import: the script loads it before it opens a database.
 */

/** The two stores of an agent manifest: the column, and the label a report prints for its rows. */
export const AGENT_MANIFEST_STORES = [
  { table: "package_versions", column: "manifest", label: "version" },
  { table: "packages", column: "draft_manifest", label: "draft" },
] as const;

/** `m` (a jsonb column) is an agent manifest carrying `runtime_tools`. */
export const carriesRuntimeTools = (m: string): string =>
  `(${m} ->> 'type' = 'agent' AND ${m} -> 'runtime_tools' IS NOT NULL)`;

/** The count of stored agent manifests {@link carriesRuntimeTools}, over both stores, as `pending`. */
export const PENDING_RUNTIME_TOOLS_COUNT = `SELECT ${AGENT_MANIFEST_STORES.map(
  (s) => `(SELECT count(*)::int FROM ${s.table} WHERE ${carriesRuntimeTools(s.column)})`,
).join(" + ")} AS pending`;
