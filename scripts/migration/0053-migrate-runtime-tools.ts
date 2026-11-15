#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0053 — every stored agent manifest moved from `runtime_tools` to the
 * `@appstrate/platform` integration (#2197, #2199):
 *
 *   set -a && . ./.env && set +a && \
 *     bun scripts/migration/0053-migrate-runtime-tools.ts --before <RFC 3339 instant> [--apply]
 *
 * Run in the release window, the app stopped, after the schema migrations and before the app
 * serves traffic (backup first). Until it runs, every stored agent runs without the platform tools
 * it had, and nothing reports it. Dry run by default (rolled back); `--apply` commits. One
 * transaction. Targets `DATABASE_URL` or `PGLITE_DATA_DIR`, exits 2 with neither
 * (`lib/database-target.ts`). It prints its mode, then the database it targets, before reading
 * or writing anything.
 *
 * `--before` is required: an RFC 3339 instant with `Z` or a numeric offset
 * (`2026-11-15T09:30:00Z`), taken after the app stopped, and the SAME value on every re-run.
 * Anything else — a date alone, no offset, an impossible date, a future instant — exits 2. Too
 * early, and the agents saved after it without the old field keep no `recall_memory` /
 * `run_history`; a later value on a re-run adds `@appstrate/platform` back to agents whose
 * authors removed it after the release.
 *
 * `log`, `note`, `pin`, `recall_memory`, `run_history` and `notify` are tools of
 * the `@appstrate/platform` system integration: an agent receives them by
 * declaring it, and `integrations_configuration.<id>.tools` restricts them.
 * `output` is injected from `output.schema`, `publish_file` is a harness tool,
 * and nothing reads `runtime_tools`. The script rewrites each agent manifest in
 * `package_versions.manifest` and `packages.draft_manifest` that carries
 * `runtime_tools`, or that was written before `--before` and does not declare
 * `@appstrate/platform` (those agents were served `recall_memory` and
 * `run_history` without declaring anything; a range that is not a string declares nothing):
 *
 *   1. `dependencies.integrations."@appstrate/platform"` = `^1.0.0` (an existing
 *      string range is kept);
 *   2. `integrations_configuration."@appstrate/platform".tools` =
 *      (`runtime_tools` ∩ {log, note, pin}) ∪ {recall_memory, run_history}, in
 *      catalog order; keys already in the entry win;
 *   3. a `runtime_tools` selecting `output` without a non-empty `output.schema`
 *      gets `output.schema` = `{ type: "object", properties: {},
 *      additionalProperties: true }`, the open schema an inline run receives
 *      (`run-and-wait-client.ts`): the agent keeps its `output` tool, a run that
 *      ends without calling it gets one corrective turn, and the platform prompt
 *      tells the model to call `output` exactly once, as its final action; the
 *      schema requires no property, so a run that never calls it still succeeds;
 *   4. `runtime_tools` is removed;
 *   5. a rewritten version gains the `package_version_dependencies` row of the dependency, the
 *      derived index publishing writes in the same transaction as the manifest
 *      (`storeVersionDependencies`), `ON CONFLICT DO NOTHING`.
 *
 * A rewritten draft's `lock_version` is incremented with it, as every draft write does: an
 * editor tab opened before the window then saves against a stale `If-Match` and is refused,
 * instead of writing the pre-migration manifest back.
 *
 * Why `--before`: an agent without the dependency is a legitimate state once its
 * author removes it, so that arm is bounded to the manifests that predate the
 * release, read off the row's own timestamp — a version's `created_at` (its
 * manifest is written once, at publish) and a draft's `updated_at` (bumped by
 * every draft save). The `runtime_tools` arm needs no bound: the field is what
 * the script removes, whenever it was written. So every WHERE is the condition
 * it removes, and a second run with the same `--before`, at once or later,
 * rewrites nothing it already rewrote.
 *
 * A manifest the rewrite cannot merge into — `dependencies`,
 * `dependencies.integrations`, `integrations_configuration` or its
 * `"@appstrate/platform"` entry present but not an object, or `output` not an
 * object when step 3 applies — is left untouched and listed, and its agent runs
 * without the platform tools. Fix each by hand, then re-run with the same
 * `--before`. Per store, the script prints how many manifests still carry
 * `runtime_tools` and how many written before `--before` still lack the
 * dependency: each is one of those listed.
 *
 * Published archives are not rewritten: a run of a published version and its
 * bundle export take the jsonb manifest of the version row
 * (`resolveAgentRunVersion`, `registry-run-resolver.ts`, `withCatalogManifest`);
 * the archive supplies the prompt and the other files.
 *
 * Exit codes: 2, refused arguments or neither database variable set (nothing opened); 1, either
 * a failure (nothing committed) or a malformed manifest left (with `--apply`, the rewrite of the
 * others committed); 0, clean.
 *
 * Rehearsal: exercised on PGlite against seeded manifests
 * (`apps/api/test/integration/db/runtime-tools-migration.test.ts`); not yet run
 * on a restored production dump. Rehearse there before the window and record
 * the counts in the README's Log.
 */

import { parseArgs } from "node:util";
import { getErrorMessage } from "@appstrate/core/errors";
import { PLATFORM_INTEGRATION_ID, PLATFORM_INTEGRATION_RANGE } from "@appstrate/core/integration";
import { parseScopedName } from "@appstrate/core/naming";
import { describeDatabaseTarget, exitUnlessDatabaseNamed } from "./lib/database-target.ts";
import { table } from "./lib/report-table.ts";

class DryRunRollback extends Error {}

const PLATFORM = `'${PLATFORM_INTEGRATION_ID}'`;
const { scope: PLATFORM_SCOPE, name: PLATFORM_NAME } = parseScopedName(PLATFORM_INTEGRATION_ID)!;

/**
 * The two stores of an agent manifest: column, write time, row label, what else a rewrite sets,
 * and what the rewritten rows `r` (each `RETURNING` the store's `returning`) add elsewhere.
 */
const STORES = [
  {
    table: "package_versions",
    column: "manifest",
    writtenAt: "created_at",
    rowLabel: `package_id || '@' || version`,
    alsoSet: "",
    returning: `id, manifest -> 'dependencies' -> 'integrations' ->> ${PLATFORM} AS range`,
    /** Step 5: the derived index row, as `storeVersionDependencies` writes it at publish. */
    alsoWrite: `, i AS (INSERT INTO package_version_dependencies
            (version_id, dep_scope, dep_name, dep_type, version_range)
          SELECT id, '@${PLATFORM_SCOPE}', '${PLATFORM_NAME}', 'integration', range FROM r
          ON CONFLICT DO NOTHING)`,
  },
  {
    table: "packages",
    column: "draft_manifest",
    writtenAt: "updated_at",
    rowLabel: `id || ' (draft)'`,
    /** The draft's `If-Match` token (`sendPackageDetail`), advanced like every draft write. */
    alsoSet: ", lock_version = lock_version + 1",
    returning: "1",
    alsoWrite: "",
  },
] as const;

type Store = (typeof STORES)[number];

/** `m` (a jsonb column) is an agent manifest carrying `runtime_tools`. */
const carriesRuntimeTools = (m: string): string =>
  `(${m} ->> 'type' = 'agent' AND ${m} -> 'runtime_tools' IS NOT NULL)`;

/** `m` declares `@appstrate/platform` with a string range; NULL when the path is absent. */
const declaresPlatform = (m: string): string =>
  `(jsonb_typeof(${m} -> 'dependencies' -> 'integrations' -> ${PLATFORM}) = 'string')`;

/** An agent manifest written before `before` that does not declare `@appstrate/platform`. */
const predatesWithoutPlatform = (store: Store, before: Date): string => {
  const m = store.column;
  return `(${m} ->> 'type' = 'agent'
    AND NOT COALESCE(${declaresPlatform(m)}, false)
    AND ${store.writtenAt} < '${before.toISOString()}'::timestamptz)`;
};

/** A manifest the rewrite targets: it carries `runtime_tools`, or predates `before` without the integration. */
const toMigrate = (store: Store, before: Date): string =>
  `(${carriesRuntimeTools(store.column)} OR ${predatesWithoutPlatform(store, before)})`;

/** `runtime_tools` selects `output` and `output.schema` is not a non-empty object (`readDeclaredOutputSchema`). */
const gainsOutputSchema = (m: string): string =>
  `(jsonb_typeof(${m} -> 'runtime_tools') = 'array'
    AND ${m} -> 'runtime_tools' @> '["output"]'::jsonb
    AND NOT COALESCE(jsonb_typeof(${m} -> 'output' -> 'schema') = 'object'
                     AND ${m} -> 'output' -> 'schema' <> '{}'::jsonb, false))`;

/** `path` is an object, or absent. */
const objectOrAbsent = (path: string): string =>
  `jsonb_typeof(COALESCE(${path}, '{}'::jsonb)) = 'object'`;

/** Every object the rewrite merges into is an object, or absent; `output` only when it gains the schema. */
const wellFormed = (m: string): string =>
  `(${[
    `${m} -> 'dependencies'`,
    `${m} -> 'dependencies' -> 'integrations'`,
    `${m} -> 'integrations_configuration'`,
    `${m} -> 'integrations_configuration' -> ${PLATFORM}`,
  ]
    .map(objectOrAbsent)
    .join("\n    AND ")}
    AND (NOT ${gainsOutputSchema(m)} OR ${objectOrAbsent(`${m} -> 'output'`)}))`;

const OPEN_OUTPUT_SCHEMA = `'{"type": "object", "properties": {}, "additionalProperties": true}'::jsonb`;

/** The rewritten manifest, steps 1 to 4 of the header. */
const withPlatform = (m: string): string =>
  `(${m} - 'runtime_tools') || jsonb_build_object(
    'dependencies',
    COALESCE(${m} -> 'dependencies', '{}'::jsonb) || jsonb_build_object(
      'integrations',
      COALESCE(${m} -> 'dependencies' -> 'integrations', '{}'::jsonb) || jsonb_build_object(
        ${PLATFORM},
        CASE WHEN ${declaresPlatform(m)}
             THEN ${m} -> 'dependencies' -> 'integrations' -> ${PLATFORM}
             ELSE to_jsonb('${PLATFORM_INTEGRATION_RANGE}'::text) END)),
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
  /** After the rewrite: the agent manifests written before `--before` still without the dependency (all among `malformed`). */
  withoutPlatformAfter: number;
}

export async function runMigrateRuntimeTools(options: {
  apply: boolean;
  before: Date;
  out: (line: string) => void;
}): Promise<Record<Store["table"], StoreCounts>> {
  const { apply, before, out } = options;
  // Imported here: `@appstrate/db/client` opens its database on import, after the entry point's guard.
  const { db, toRows } = await import("@appstrate/db/client");
  out(await describeDatabaseTarget());
  const result = {} as Record<Store["table"], StoreCounts>;
  let committed = false;
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
            SET ${m} = ${withPlatform(m)}${store.alsoSet}
            WHERE ${target} AND ${wellFormed(m)}
            RETURNING ${store.returning})${store.alsoWrite}
          SELECT count(*)::int AS n FROM r`);
        const carryingAfter = await n(`SELECT count(*)::int AS n FROM ${store.table}
          WHERE ${carriesRuntimeTools(m)}`);
        const withoutPlatformAfter = await n(`SELECT count(*)::int AS n FROM ${store.table}
          WHERE ${predatesWithoutPlatform(store, before)}`);
        result[store.table] = {
          rewritten,
          outputSchemaAdded,
          malformed,
          carryingAfter,
          withoutPlatformAfter,
        };
      }
      table(
        [
          "store",
          "rewritten",
          "of which output.schema added",
          "malformed, left untouched",
          "after: carrying runtime_tools",
          "after: before --before, no @appstrate/platform",
        ],
        STORES.map((s) => [
          s.table,
          String(result[s.table].rewritten),
          String(result[s.table].outputSchemaAdded),
          String(result[s.table].malformed.length),
          String(result[s.table].carryingAfter),
          String(result[s.table].withoutPlatformAfter),
        ]),
      ).forEach(out);
      if (!apply) throw new DryRunRollback();
    });
    committed = true;
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  const malformed = STORES.flatMap((s) => result[s.table].malformed);
  if (malformed.length > 0) {
    out("");
    out("malformed (fix by hand):");
    malformed.forEach((label) => out(`  ${label}`));
    out(
      `${malformed.length} malformed manifest(s) left untouched: their agents run without the ` +
        `${PLATFORM_INTEGRATION_ID} tools. Fix each by hand, then re-run with the same --before.`,
    );
  }
  out(
    committed
      ? "0053: APPLIED — committed."
      : "0053: DRY RUN — rolled back, nothing written. Re-run with --apply to commit.",
  );
  return result;
}

/** RFC 3339 date-time with a `Z` or numeric offset (§5.6), seconds required, fraction optional. */
const RFC3339_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * `--before`, or why it is refused: an RFC 3339 instant with `Z` or a numeric offset, a real
 * calendar date and time, not after `now`. Every other form — a date alone, no offset, a number —
 * would move the bound silently (`new Date` reads them as UTC midnight, the machine's zone, a year).
 */
export function parseBefore(
  value: string | undefined,
  now: number,
): { before: Date } | { refusal: string } {
  if (value === undefined) return { refusal: "--before is required" };
  const match = RFC3339_INSTANT.exec(value);
  if (!match) {
    return {
      refusal: `--before ${value} is not an RFC 3339 instant with Z or an offset (2026-11-15T09:30:00Z)`,
    };
  }
  const time = Date.parse(value);
  const offsetMinutes =
    (match[1] === "-" ? -1 : 1) * (Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0));
  // `Date.parse` rolls an impossible date over (30 February reads as 2 March, 24:00 as the next
  // day): the instant, read back at its own offset, must give the wall clock written.
  if (
    Number.isNaN(time) ||
    new Date(time + offsetMinutes * 60_000).toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    return { refusal: `--before ${value} is not a valid date and time` };
  }
  if (time > now) return { refusal: `--before ${value} is in the future` };
  return { before: new Date(time) };
}

const USAGE =
  "usage: bun scripts/migration/0053-migrate-runtime-tools.ts --before <RFC 3339 instant, the same on every run> [--apply]";

/** The arguments, or why they are refused. */
export function parseArguments(
  args: string[],
  now: number,
): { apply: boolean; before: Date } | { refusal: string } {
  let values: { apply?: boolean; before?: string };
  try {
    ({ values } = parseArgs({
      args,
      options: { apply: { type: "boolean" }, before: { type: "string" } },
      strict: true,
    }));
  } catch (error) {
    return { refusal: getErrorMessage(error) };
  }
  const parsed = parseBefore(values.before, now);
  return "refusal" in parsed ? parsed : { apply: values.apply === true, before: parsed.before };
}

/** The exit code of an outcome: refused arguments, a failure, or the counts of a completed run. */
export function exitCode(
  outcome: { refusal: string } | { failure: unknown } | Record<Store["table"], StoreCounts>,
): 0 | 1 | 2 {
  if ("refusal" in outcome) return 2;
  if ("failure" in outcome) return 1;
  return STORES.some((s) => outcome[s.table].malformed.length > 0) ? 1 : 0;
}

if (import.meta.main) {
  const args = parseArguments(process.argv.slice(2), Date.now());
  if ("refusal" in args) {
    process.stdout.write(`${args.refusal} — ${USAGE}\n`);
    process.exit(exitCode(args));
  }
  const { apply, before } = args;
  exitUnlessDatabaseNamed();
  let outcome: Parameters<typeof exitCode>[0];
  let closeDb: (() => Promise<void>) | undefined;
  try {
    ({ closeDb } = await import("@appstrate/db/client"));
    const out = (line: string) => process.stdout.write(`${line}\n`);
    out(`0053 — ${apply ? "APPLY" : "DRY RUN"}, before ${before.toISOString()}`);
    outcome = await runMigrateRuntimeTools({ apply, before, out });
  } catch (failure) {
    outcome = { failure };
    process.stdout.write(`0053: FAILED, nothing committed — ${getErrorMessage(failure)}\n`);
  } finally {
    await closeDb?.();
  }
  process.exit(exitCode(outcome));
}
