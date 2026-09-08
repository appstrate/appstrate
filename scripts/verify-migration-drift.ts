#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Gate — `packages/db/src/schema/**` must not have moved ahead of
 * `packages/db/drizzle/`.
 *
 * `db:generate` is a manual step. Nothing in `bun run check` asked whether it
 * had been run, and no other gate can: `typecheck` compiles the schema,
 * `bun test` runs against PGlite built from the same schema, so BOTH are green
 * on a tree whose committed migrations no longer describe it. The divergence
 * only becomes visible on the one database nobody can re-create — production,
 * at deploy time, after the container has already been swapped.
 *
 * This repo has been bitten by that family three times: two indexes present in
 * the schema and missing from prod (`0000_init` is a squash and prod predates
 * it), a migration silently skipped because the journal watermark was ahead of
 * `max(created_at)`, and a migration-index collision from two branches
 * generating from the same parent snapshot. The last of those is what
 * `drizzle-kit check` catches, and is why this gate runs both commands.
 *
 * ─── Why a temp directory, and not `--out packages/db/drizzle` ───────
 *
 * `drizzle-kit generate` WRITES: a `.sql` file and a `meta/NNNN_snapshot.json`,
 * plus an appended `meta/_journal.json` entry. A gate that generated in place
 * and cleaned up afterwards would leave all three behind on any interrupt —
 * Ctrl-C during a pre-push hook, a killed CI step — and the residue is a
 * migration file that looks committable. So the whole directory is COPIED to
 * `mkdtemp` and both commands run there. `packages/db/drizzle/` is opened
 * read-only by this script, at any exit path.
 *
 * ─── Three measured facts about drizzle-kit 0.31.10 ──────────────────
 *
 * Measured 2026-09-08 on this tree. None of these are assumptions, and the
 * control flow below depends on all three.
 *
 *   1. `--out` is joined onto the CWD with a `./` prefix, so an ABSOLUTE path
 *      becomes `.//private/tmp/…` and resolves under the CWD:
 *
 *        $ drizzle-kit generate --out=/tmp/x/drizzle …
 *        Error: ENOENT … open './/tmp/x/drizzle/meta/0000_snapshot.json'
 *
 *      Hence `cwd: tmpDir` plus a RELATIVE `--out`. `--schema` takes an
 *      absolute path fine; it is globbed, not joined.
 *
 *   2. The exit code is not a verdict. A missing schema path exits 1, but the
 *      interactive-prompt failure — reached whenever the diff contains a
 *      RENAME, because drizzle-kit asks "is column X renamed to Y?" — prints a
 *      stack trace and exits **0**:
 *
 *        $ … generate … < /dev/null; echo $?
 *        Error: Interactive prompts require a TTY terminal …
 *        0
 *
 *      So a green exit is read as a pass only when it is CORROBORATED, either
 *      by a generated file or by the `NOTHING_TO_MIGRATE` marker. Anything
 *      else fails the gate rather than passing quietly — which is also the
 *      right answer for the rename case, since a rename the developer has not
 *      generated a migration for IS drift.
 *
 *   3. `--name` makes the run non-interactive as far as NAMING goes (without
 *      it drizzle-kit picks a random name; it does not prompt). It does not
 *      suppress the rename prompt — see (2). stdin is closed regardless, so a
 *      prompt errors out instead of hanging a pre-push hook forever.
 *
 * ─── What `drizzle-kit check` adds, and what it does not ─────────────
 *
 * It reads the snapshot chain, not the journal. Two probes on a temp copy,
 * 2026-09-08:
 *
 *   - duplicating the last `_journal.json` entry under the same `idx`
 *     → `Everything's fine 🐶🔥`, exit 0. NOT detected.
 *   - two snapshots pointing at the same parent (the shape two branches
 *     produce when both generate from the same tip)
 *     → `[…0055_snapshot.json, …0056_snapshot.json] are pointing to a parent
 *       snapshot: …0055_snapshot.json which is a collision.`, exit 1.
 *
 * The second is exactly the collision this repo hit, so the command earns its
 * place; the first is why it is not described here as "validates the journal".
 *
 * Usage: bun scripts/verify-migration-drift.ts
 */

import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "packages/db/drizzle");
const SCHEMA_ENTRY = join(REPO_ROOT, "packages/db/src/schema/index.ts");

/**
 * The name given to the migration this gate would generate.
 *
 * It never reaches `packages/db/drizzle/`, but it is the filename quoted back
 * to the developer, so it says what produced it rather than reading like a
 * migration somebody forgot to delete.
 */
const PROBE_NAME = "verify_migration_drift";

/** drizzle-kit's own "there is nothing to generate" line. */
const NOTHING_TO_MIGRATE = "No schema changes, nothing to migrate";

/**
 * Where `bun install` puts the `drizzle-kit` binary.
 *
 * `drizzle-kit` is a devDependency of `packages/db` alone, so bun installs it
 * package-locally; the root `.bin` does not have it (checked 2026-09-08). The
 * root path is tried as well because hoisting is bun's decision, not this
 * script's, and a gate that hard-codes one layout breaks on a lockfile change
 * with an error about a missing file rather than about the gate.
 */
const DRIZZLE_KIT_CANDIDATES = [
  join(REPO_ROOT, "packages/db/node_modules/.bin/drizzle-kit"),
  join(REPO_ROOT, "node_modules/.bin/drizzle-kit"),
] as const;

function drizzleKitBin(): string {
  const found = DRIZZLE_KIT_CANDIDATES.find((p) => existsSync(p));
  if (found === undefined) {
    throw new Error(
      `drizzle-kit binary not found. Looked in:\n` +
        DRIZZLE_KIT_CANDIDATES.map((p) => `  - ${p}`).join("\n") +
        `\nRun \`bun install\`.`,
    );
  }
  return found;
}

/** One drizzle-kit invocation's raw result — stdout and stderr already merged. */
interface CommandResult {
  exitCode: number;
  output: string;
}

function runDrizzleKit(bin: string, cwd: string, args: readonly string[]): CommandResult {
  const run = Bun.spawnSync({
    cmd: [bin, ...args],
    cwd,
    // Closed, so the rename prompt errors instead of hanging a pre-push hook.
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: run.exitCode,
    output: `${run.stdout.toString()}${run.stderr.toString()}`,
  };
}

/** What one full pass concluded, plus the counts that prove it read something. */
export interface DriftReview {
  problems: string[];
  /** `.sql` files in `packages/db/drizzle/` at the time of the run. */
  migrations: number;
  /** Tables drizzle-kit read out of the schema — 0 means it compiled nothing. */
  tables: number;
}

/**
 * drizzle-kit prints `N tables` before the per-table listing. Read back so the
 * success line reports what was actually compared: a schema entrypoint that
 * resolved to nothing would otherwise report "no drift" over an empty diff.
 */
function tableCount(output: string): number {
  const match = /^(\d+) tables$/m.exec(output);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

/**
 * Turn one `generate` result into findings.
 *
 * Pure, so `scripts/test/verify-migration-drift.test.ts` can drive every branch
 * — including the exit-0-with-a-stack-trace case, which cannot be reached by
 * running the real command against a clean tree.
 *
 * `pending` is the `.sql` files that appeared in the temp copy, mapped to their
 * contents. Printing the SQL is the point: "drift detected" tells a developer
 * nothing they can act on, whereas the `ALTER TABLE` they are missing tells
 * them whether they forgot to generate or changed the schema by accident.
 */
export function reviewGenerate(
  result: CommandResult,
  pending: ReadonlyMap<string, string>,
): string[] {
  if (result.exitCode !== 0) {
    return [
      `drizzle-kit generate failed (exit ${result.exitCode}). This gate cannot tell whether ` +
        `the schema has drifted, so it fails rather than passing.\n` +
        indent(result.output),
    ];
  }

  if (pending.size > 0) {
    const sql = [...pending]
      .map(([name, body]) => `  ── ${name} ──\n${indent(body.trim())}`)
      .join("\n");
    return [
      `packages/db/src/schema/** has changed without a migration. drizzle-kit would generate ` +
        `${pending.size} file(s):\n${sql}\n` +
        `    → run \`bun run db:generate\`, review the SQL, and commit it with the schema change.`,
    ];
  }

  if (result.output.includes(NOTHING_TO_MIGRATE)) return [];

  // Exit 0, nothing generated, and no marker — the shape the rename prompt
  // produces (see fact 2 in the header). Never a pass.
  return [
    `drizzle-kit generate produced neither a migration nor "${NOTHING_TO_MIGRATE}", and exited ` +
      `0 anyway. The usual cause is a RENAME in the schema: drizzle-kit stops to ask whether a ` +
      `column or table was renamed or dropped-and-added, and cannot ask without a terminal.\n` +
      indent(result.output) +
      `\n    → run \`bun run db:generate\` in a terminal, answer the prompt, and commit the SQL.`,
  ];
}

/** Two-space indent, for quoting a tool's output inside a finding. */
function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")
    .trimEnd();
}

/** `check`'s findings — it is a verdict command, so its exit code IS the answer. */
export function reviewCheck(result: CommandResult): string[] {
  if (result.exitCode === 0) return [];
  return [
    `drizzle-kit check rejected packages/db/drizzle/:\n${indent(result.output)}\n` +
      `    → two migrations generated from the same parent snapshot collide. Regenerate the ` +
      `later one on top of the earlier: delete its .sql and meta/*_snapshot.json, revert its ` +
      `meta/_journal.json entry, then \`bun run db:generate\`.`,
  ];
}

function main(): number {
  const bin = drizzleKitBin();

  if (!statSync(MIGRATIONS_DIR).isDirectory()) {
    throw new Error(`${MIGRATIONS_DIR} is not a directory.`);
  }
  const before = new Set(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")));
  if (before.size === 0) {
    throw new Error(`${MIGRATIONS_DIR} holds no .sql file — the gate would pass vacuously.`);
  }

  const workspace = mkdtempSync(join(tmpdir(), "appstrate-migration-drift-"));
  try {
    const out = join(workspace, "drizzle");
    cpSync(MIGRATIONS_DIR, out, { recursive: true });

    const problems = [
      ...reviewCheck(
        runDrizzleKit(bin, workspace, ["check", "--dialect=postgresql", "--out=drizzle"]),
      ),
    ];

    const generate = runDrizzleKit(bin, workspace, [
      "generate",
      "--dialect=postgresql",
      `--schema=${SCHEMA_ENTRY}`,
      "--out=drizzle",
      `--name=${PROBE_NAME}`,
    ]);

    const pending = new Map(
      readdirSync(out)
        .filter((f) => f.endsWith(".sql") && !before.has(f))
        .sort()
        .map((f) => [f, readFileSync(join(out, f), "utf8")] as const),
    );

    problems.push(...reviewGenerate(generate, pending));

    if (problems.length > 0) {
      for (const p of problems) console.error(`❌ ${p}`);
      return 1;
    }

    console.log(
      `✅ schema and migrations agree — ${before.size} migration(s), ` +
        `${tableCount(generate.output)} table(s) compared.`,
    );
    return 0;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

// Guarded so `scripts/test/verify-migration-drift.test.ts` can import the pure
// reviewers without spawning drizzle-kit — same pattern as
// `verify-no-migration-dml.ts`.
if (import.meta.main) {
  process.exit(main());
}
