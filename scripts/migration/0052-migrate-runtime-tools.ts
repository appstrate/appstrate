#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0052 — every stored agent manifest moved from `runtime_tools` to the
 * `@appstrate/platform` integration (#2197, #2199):
 *
 *   set -a && . ./.env && set +a && \
 *     bun scripts/migration/0052-migrate-runtime-tools.ts [--apply]
 *
 * Run in the deployment window of the release that ships #2199, the app stopped,
 * `pg_dump` first. Dry run by default: it prints the report and rolls back;
 * `--apply` commits. Targets `DATABASE_URL` or `PGLITE_DATA_DIR`, exits 2 with
 * neither (`lib/database-target.ts`). One transaction.
 *
 * `log`, `note`, `pin`, `recall_memory`, `run_history` and `notify` are tools of
 * the `@appstrate/platform` system integration: an agent receives them by
 * declaring it, and `integrations_configuration.<id>.tools` restricts them.
 * `output` is injected from `output.schema`, `publish_file` is a harness tool,
 * and nothing reads `runtime_tools`. For each agent manifest in
 * `package_versions.manifest` and `packages.draft_manifest` that carries
 * `runtime_tools` or does not declare `@appstrate/platform`:
 *
 *   1. `dependencies.integrations."@appstrate/platform"` = `^1.0.0` (an existing
 *      range is kept);
 *   2. `integrations_configuration."@appstrate/platform".tools` =
 *      (`runtime_tools` ∩ {log, note, pin}) ∪ {recall_memory, run_history}, in
 *      catalog order — `recall_memory` and `run_history` were served to every
 *      agent; keys already in the entry win;
 *   3. a `runtime_tools` selecting `output` without a non-empty `output.schema`
 *      gets `output.schema` = `{ type: "object", properties: {},
 *      additionalProperties: true }`, the open schema an inline run receives
 *      (`run-and-wait-client.ts`), so the agent keeps its `output` tool. It
 *      requires no property, so `{}` validates and a run that never calls the
 *      tool still succeeds;
 *   4. `runtime_tools` is removed.
 *
 * The rewrite also reaches agents that never carried `runtime_tools` (they were
 * served `recall_memory` and `run_history` without declaring anything). The boot
 * guard (`assertRuntimeToolsMigrated`) can only see the field: an agent without
 * the dependency is a legitimate state once its author removes it. So this
 * script is REQUIRED in the window even though the platform boots without it on
 * a database where no manifest carries `runtime_tools`.
 *
 * A manifest whose `dependencies`, `dependencies.integrations`,
 * `integrations_configuration`, its `"@appstrate/platform"` entry or `output` is
 * present but not an object is left untouched, counted and listed: fix it by
 * hand, since the boot guard refuses to start while it carries `runtime_tools`.
 *
 * Published archives are not rewritten: a run of a published version and its
 * bundle export take the jsonb manifest of the version row
 * (`resolveAgentRunVersion`, the registry resolver, `withCatalogManifest`); the
 * archive supplies the prompt and the other files.
 *
 * An immediate second `--apply` writes nothing. A LATER one is not idempotent in
 * effect: it re-adds the dependency to every agent whose author has since
 * removed it. Run it once.
 *
 * Rehearsal: not yet run against a copy of production; counts UNMEASURED.
 */

import { parseArgs } from "node:util";
import { getErrorMessage } from "@appstrate/core/errors";
import { PLATFORM_INTEGRATION_ID, PLATFORM_INTEGRATION_RANGE } from "@appstrate/core/integration";
import { exitUnlessDatabaseNamed } from "./lib/database-target.ts";
import { table } from "./lib/report-table.ts";

class DryRunRollback extends Error {}

/** The two stores of an agent manifest: the column, and the label printed for its rows. */
const STORES = [
  { table: "package_versions", column: "manifest", label: "version" },
  { table: "packages", column: "draft_manifest", label: "draft" },
] as const;

type Store = (typeof STORES)[number];

const PLATFORM = `'${PLATFORM_INTEGRATION_ID}'`;

/**
 * THE predicate of what this script removes: a stored agent manifest that still carries
 * `runtime_tools`. The boot guard (`assertRuntimeToolsMigrated`) counts it.
 */
export const carriesRuntimeTools = (m: string): string =>
  `(${m} ->> 'type' = 'agent' AND ${m} -> 'runtime_tools' IS NOT NULL)`;

/** The count of stored agent manifests {@link carriesRuntimeTools}, over both stores. */
export const PENDING_RUNTIME_TOOLS_COUNT = `SELECT ${STORES.map(
  (s) => `(SELECT count(*)::int FROM ${s.table} WHERE ${carriesRuntimeTools(s.column)})`,
).join(" + ")} AS pending`;

/** An agent manifest the rewrite targets: it carries `runtime_tools` or does not declare the integration. */
const toMigrate = (m: string): string =>
  `(${m} ->> 'type' = 'agent'
    AND (${m} -> 'runtime_tools' IS NOT NULL
         OR ${m} -> 'dependencies' -> 'integrations' -> ${PLATFORM} IS NULL))`;

/** Every object the rewrite merges into is an object, or absent. */
const wellFormed = (m: string): string =>
  `(${[
    `${m} -> 'dependencies'`,
    `${m} -> 'dependencies' -> 'integrations'`,
    `${m} -> 'integrations_configuration'`,
    `${m} -> 'integrations_configuration' -> ${PLATFORM}`,
    `${m} -> 'output'`,
  ]
    .map((path) => `jsonb_typeof(COALESCE(${path}, '{}'::jsonb)) = 'object'`)
    .join("\n    AND ")})`;

/** `runtime_tools` selects `output` and `output.schema` is not a non-empty object (`readDeclaredOutputSchema`). */
const gainsOutputSchema = (m: string): string =>
  `(jsonb_typeof(${m} -> 'runtime_tools') = 'array'
    AND ${m} -> 'runtime_tools' @> '["output"]'::jsonb
    AND NOT COALESCE(jsonb_typeof(${m} -> 'output' -> 'schema') = 'object'
                     AND ${m} -> 'output' -> 'schema' <> '{}'::jsonb, false))`;

const OPEN_OUTPUT_SCHEMA = `'{"type": "object", "properties": {}, "additionalProperties": true}'::jsonb`;

/** The rewritten manifest, steps 1 to 4 of the header. */
const withPlatform = (m: string): string =>
  `(${m} - 'runtime_tools') || jsonb_build_object(
    'dependencies',
    COALESCE(${m} -> 'dependencies', '{}'::jsonb) || jsonb_build_object(
      'integrations',
      COALESCE(${m} -> 'dependencies' -> 'integrations', '{}'::jsonb) || jsonb_build_object(
        ${PLATFORM},
        COALESCE(${m} -> 'dependencies' -> 'integrations' -> ${PLATFORM},
                 to_jsonb('${PLATFORM_INTEGRATION_RANGE}'::text)))),
    'integrations_configuration',
    COALESCE(${m} -> 'integrations_configuration', '{}'::jsonb) || jsonb_build_object(
      ${PLATFORM},
      jsonb_build_object('tools', (
        SELECT jsonb_agg(c.tool ORDER BY c.ord)
        FROM unnest(ARRAY['log', 'note', 'pin', 'recall_memory', 'run_history'])
          WITH ORDINALITY AS c(tool, ord)
        WHERE c.tool IN ('recall_memory', 'run_history')
           OR (jsonb_typeof(${m} -> 'runtime_tools') = 'array'
               AND ${m} -> 'runtime_tools' @> jsonb_build_array(c.tool))))
      || COALESCE(${m} -> 'integrations_configuration' -> ${PLATFORM}, '{}'::jsonb)))
  || CASE WHEN ${gainsOutputSchema(m)}
       THEN jsonb_build_object('output',
              COALESCE(${m} -> 'output', '{}'::jsonb)
              || jsonb_build_object('schema', ${OPEN_OUTPUT_SCHEMA}))
       ELSE '{}'::jsonb END`;

export interface StoreCounts {
  rewritten: number;
  /** Of `rewritten`, the manifests that received the open `output.schema`. */
  outputSchemaAdded: number;
  /** Targeted but left untouched: a shape the rewrite cannot merge into. */
  malformed: string[];
}

export type RuntimeToolsMigration = Record<Store["label"], StoreCounts>;

/** Labels a row of `store`: `@scope/name@version` or `@scope/name (draft)`. */
const rowLabel = (store: Store): string =>
  store.table === "package_versions" ? `package_id || '@' || version` : `id || ' (draft)'`;

export async function runMigrateRuntimeTools(options: {
  apply: boolean;
  out: (line: string) => void;
}): Promise<RuntimeToolsMigration> {
  const { apply, out } = options;
  // Imported here: `@appstrate/db/client` opens its database on import, after the entry point's guard.
  const { db, toRows } = await import("@appstrate/db/client");
  const result = {} as RuntimeToolsMigration;
  try {
    await db.transaction(async (tx) => {
      await tx.execute("SET LOCAL lock_timeout = '5s'");
      await tx.execute("SET LOCAL statement_timeout = '300s'");
      for (const store of STORES) {
        const m = store.column;
        const malformed = toRows<{ label: string }>(
          await tx.execute(`SELECT ${rowLabel(store)} AS label FROM ${store.table}
            WHERE ${toMigrate(m)} AND NOT ${wellFormed(m)} ORDER BY 1`),
        ).map((r) => r.label);
        const [gaining] = toRows<{ n: number }>(
          await tx.execute(`SELECT count(*)::int AS n FROM ${store.table}
            WHERE ${toMigrate(m)} AND ${wellFormed(m)} AND ${gainsOutputSchema(m)}`),
        );
        const rewritten = toRows<{ one: number }>(
          await tx.execute(`UPDATE ${store.table}
            SET ${m} = ${withPlatform(m)}
            WHERE ${toMigrate(m)} AND ${wellFormed(m)}
            RETURNING 1 AS one`),
        );
        result[store.label] = {
          rewritten: rewritten.length,
          outputSchemaAdded: gaining!.n,
          malformed,
        };
      }
      report(result).forEach(out);
      if (!apply) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
    out("0052: DRY RUN — rolled back, nothing written. Re-run with --apply to commit.");
    return result;
  }
  out("0052: APPLIED — committed.");
  return result;
}

export function report(result: RuntimeToolsMigration): string[] {
  const lines = table(
    ["store", "rewritten", "of which output.schema added", "malformed, left untouched"],
    STORES.map((s) => [
      s.table,
      String(result[s.label].rewritten),
      String(result[s.label].outputSchemaAdded),
      String(result[s.label].malformed.length),
    ]),
  );
  const malformed = STORES.flatMap((s) => result[s.label].malformed);
  if (malformed.length === 0) return lines;
  return [...lines, "", "malformed (fix by hand):", ...malformed.map((label) => `  ${label}`)];
}

if (import.meta.main) {
  exitUnlessDatabaseNamed();
  let code = 1;
  let closeDb: (() => Promise<void>) | undefined;
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { apply: { type: "boolean" } },
      strict: true,
    });
    const apply = values.apply === true;
    ({ closeDb } = await import("@appstrate/db/client"));
    const out = (line: string) => process.stdout.write(`${line}\n`);
    out(`0052 — ${apply ? "APPLY" : "DRY RUN"}`);
    await runMigrateRuntimeTools({ apply, out });
    code = 0;
  } catch (error) {
    process.stdout.write(`0052: FAILED, nothing committed — ${getErrorMessage(error)}\n`);
  } finally {
    await closeDb?.();
  }
  process.exit(code);
}
