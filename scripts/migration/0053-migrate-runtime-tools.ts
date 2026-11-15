#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0053 — every stored agent manifest moved from `runtime_tools` to the
 * `@appstrate/platform` integration (#2197, #2199):
 *
 *   set -a && . ./.env && set +a && \
 *     bun scripts/migration/0053-migrate-runtime-tools.ts --before <deploy time, ISO 8601> [--apply]
 *
 * Run in the deployment window of the release that ships #2199, once no run is
 * `running`, the app stopped, `pg_dump` first. Dry run by default (rolled back);
 * `--apply` commits. One transaction. Targets `DATABASE_URL` or
 * `PGLITE_DATA_DIR`, exits 2 with neither (`lib/database-target.ts`); exits 2
 * without `--before`, or with one in the future.
 *
 * `log`, `note`, `pin`, `recall_memory`, `run_history` and `notify` are tools of
 * the `@appstrate/platform` system integration: an agent receives them by
 * declaring it, and `integrations_configuration.<id>.tools` restricts them.
 * `output` is injected from `output.schema`, `publish_file` is a harness tool,
 * and nothing reads `runtime_tools`. The script rewrites each agent manifest in
 * `package_versions.manifest` and `packages.draft_manifest` that carries
 * `runtime_tools`, or that was written before `--before` and does not declare
 * `@appstrate/platform` (those agents were served `recall_memory` and
 * `run_history` without declaring anything):
 *
 *   1. `dependencies.integrations."@appstrate/platform"` = `^1.0.0` (an existing
 *      range is kept);
 *   2. `integrations_configuration."@appstrate/platform".tools` =
 *      (`runtime_tools` ∩ {log, note, pin}) ∪ {recall_memory, run_history}, in
 *      catalog order; keys already in the entry win;
 *   3. a `runtime_tools` selecting `output` without a non-empty `output.schema`
 *      gets `output.schema` = `{ type: "object", properties: {},
 *      additionalProperties: true }`, the open schema an inline run receives
 *      (`run-and-wait-client.ts`), so the agent keeps its `output` tool. It
 *      requires no property, so a run that never calls the tool still succeeds;
 *   4. `runtime_tools` is removed.
 *
 * Why `--before` (the deploy time): an agent without the dependency is a
 * legitimate state once its author removes it, so that arm is bounded to the
 * manifests that predate the release, read off the row's own timestamp — a
 * version's `created_at` (its manifest is written once, at publish) and a
 * draft's `updated_at` (bumped by every draft save). A manifest written after
 * the deploy is the release's or its author's. The `runtime_tools` arm needs no
 * bound: the field is what the script removes, whenever it was written. So every
 * WHERE is the condition it removes, and a second run, at once or later,
 * rewrites nothing it already rewrote.
 *
 * A manifest whose `dependencies`, `dependencies.integrations`,
 * `integrations_configuration`, its `"@appstrate/platform"` entry or `output` is
 * present but not an object is left untouched and listed: fix it by hand. After
 * the rewrite the script prints how many manifests still carry
 * `runtime_tools`; each is one of those.
 *
 * Published archives are not rewritten: a run of a published version and its
 * bundle export take the jsonb manifest of the version row
 * (`resolveAgentRunVersion`, the registry resolver, `withCatalogManifest`); the
 * archive supplies the prompt and the other files.
 *
 * Rehearsal: exercised on PGlite against seeded manifests
 * (`apps/api/test/integration/db/runtime-tools-migration.test.ts`); not yet run
 * on a restored production dump. Rehearse there before the window and record
 * the counts in the README's Log.
 */

import { parseArgs } from "node:util";
import { getErrorMessage } from "@appstrate/core/errors";
import { PLATFORM_INTEGRATION_ID, PLATFORM_INTEGRATION_RANGE } from "@appstrate/core/integration";
import { exitUnlessDatabaseNamed } from "./lib/database-target.ts";
import { table } from "./lib/report-table.ts";

class DryRunRollback extends Error {}

/** The two stores of an agent manifest: its column, when it was written, and how a row is named. */
const STORES = [
  {
    table: "package_versions",
    column: "manifest",
    writtenAt: "created_at",
    rowLabel: `package_id || '@' || version`,
    key: "version",
  },
  {
    table: "packages",
    column: "draft_manifest",
    writtenAt: "updated_at",
    rowLabel: `id || ' (draft)'`,
    key: "draft",
  },
] as const;

type Store = (typeof STORES)[number];

const PLATFORM = `'${PLATFORM_INTEGRATION_ID}'`;

/** `m` (a jsonb column) is an agent manifest carrying `runtime_tools`. */
const carriesRuntimeTools = (m: string): string =>
  `(${m} ->> 'type' = 'agent' AND ${m} -> 'runtime_tools' IS NOT NULL)`;

/** A manifest the rewrite targets: it carries `runtime_tools`, or predates `before` without the integration. */
const toMigrate = (store: Store, before: Date): string => {
  const m = store.column;
  return `(${carriesRuntimeTools(m)}
    OR (${m} ->> 'type' = 'agent'
        AND ${m} -> 'dependencies' -> 'integrations' -> ${PLATFORM} IS NULL
        AND ${store.writtenAt} < '${before.toISOString()}'::timestamptz))`;
};

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

interface StoreCounts {
  rewritten: number;
  /** Of `rewritten`, the manifests that received the open `output.schema`. */
  outputSchemaAdded: number;
  /** Targeted but left untouched: a shape the rewrite cannot merge into. */
  malformed: string[];
  /** After the rewrite: the agent manifests still carrying `runtime_tools` (all among `malformed`). */
  carryingAfter: number;
}

export async function runMigrateRuntimeTools(options: {
  apply: boolean;
  before: Date;
  out: (line: string) => void;
}): Promise<Record<Store["key"], StoreCounts>> {
  const { apply, before, out } = options;
  // Imported here: `@appstrate/db/client` opens its database on import, after the entry point's guard.
  const { db, toRows } = await import("@appstrate/db/client");
  const result = {} as Record<Store["key"], StoreCounts>;
  try {
    await db.transaction(async (tx) => {
      await tx.execute("SET LOCAL lock_timeout = '5s'");
      await tx.execute("SET LOCAL statement_timeout = '300s'");
      const n = async (query: string): Promise<number> =>
        toRows<{ n: number }>(await tx.execute(query))[0]!.n;
      for (const store of STORES) {
        const m = store.column;
        const target = toMigrate(store, before);
        const malformed = toRows<{ label: string }>(
          await tx.execute(`SELECT ${store.rowLabel} AS label FROM ${store.table}
            WHERE ${target} AND NOT ${wellFormed(m)} ORDER BY 1`),
        ).map((r) => r.label);
        const outputSchemaAdded = await n(`SELECT count(*)::int AS n FROM ${store.table}
          WHERE ${target} AND ${wellFormed(m)} AND ${gainsOutputSchema(m)}`);
        const rewritten = await n(`WITH r AS (UPDATE ${store.table}
            SET ${m} = ${withPlatform(m)}
            WHERE ${target} AND ${wellFormed(m)}
            RETURNING 1)
          SELECT count(*)::int AS n FROM r`);
        const carryingAfter = await n(`SELECT count(*)::int AS n FROM ${store.table}
          WHERE ${carriesRuntimeTools(m)}`);
        result[store.key] = { rewritten, outputSchemaAdded, malformed, carryingAfter };
      }
      table(
        [
          "store",
          "rewritten",
          "of which output.schema added",
          "malformed, left untouched",
          "still carrying runtime_tools",
        ],
        STORES.map((s) => [
          s.table,
          String(result[s.key].rewritten),
          String(result[s.key].outputSchemaAdded),
          String(result[s.key].malformed.length),
          String(result[s.key].carryingAfter),
        ]),
      ).forEach(out);
      const malformed = STORES.flatMap((s) => result[s.key].malformed);
      if (malformed.length > 0) {
        out("");
        out("malformed (fix by hand):");
        malformed.forEach((label) => out(`  ${label}`));
      }
      if (!apply) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
    out("0053: DRY RUN — rolled back, nothing written. Re-run with --apply to commit.");
    return result;
  }
  out("0053: APPLIED — committed.");
  return result;
}

const USAGE =
  "usage: bun scripts/migration/0053-migrate-runtime-tools.ts --before <deploy time, ISO 8601> [--apply]";

function exitWithUsage(reason: string): never {
  process.stdout.write(`${reason} — ${USAGE}\n`);
  process.exit(2);
}

/** The arguments, or exit 2: `--before` is required and must name a past instant (the deploy). */
function parseArguments(): { apply: boolean; before: Date } {
  let values: { apply?: boolean; before?: string };
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: { apply: { type: "boolean" }, before: { type: "string" } },
      strict: true,
    }));
  } catch (error) {
    exitWithUsage(getErrorMessage(error));
  }
  if (values.before === undefined) exitWithUsage("--before is required");
  const before = new Date(values.before);
  if (Number.isNaN(before.getTime()) || before.getTime() > Date.now()) {
    exitWithUsage(`--before ${values.before} is not a past instant`);
  }
  return { apply: values.apply === true, before };
}

if (import.meta.main) {
  const { apply, before } = parseArguments();
  exitUnlessDatabaseNamed();
  let code = 1;
  let closeDb: (() => Promise<void>) | undefined;
  try {
    ({ closeDb } = await import("@appstrate/db/client"));
    const out = (line: string) => process.stdout.write(`${line}\n`);
    out(`0053 — ${apply ? "APPLY" : "DRY RUN"}, before ${before.toISOString()}`);
    await runMigrateRuntimeTools({ apply, before, out });
    code = 0;
  } catch (error) {
    process.stdout.write(`0053: FAILED, nothing committed — ${getErrorMessage(error)}\n`);
  } finally {
    await closeDb?.();
  }
  process.exit(code);
}
