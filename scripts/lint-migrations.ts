#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Gate — lock safety in `packages/db/drizzle/*.sql`, via squawk.
 *
 * Every migration in this repo is replayed on production inside ONE
 * transaction, so a statement that takes a heavy lock holds it until the whole
 * batch commits. That cost has been paid in production already: one migration
 * took 400 seconds, and a rename had to be split into two halves and rehearsed
 * against a replica before it could ship. The reasoning that avoided worse was
 * done by hand, in migration headers, one file at a time — `0050`'s header
 * spends thirty lines on which lock `CREATE INDEX` takes and why
 * `lock_timeout` alone is not a fence. Nothing checked that the NEXT migration
 * did the same.
 *
 * squawk is a PostgreSQL migration linter (https://squawkhq.com). It is a
 * local binary, runs offline, and needs no database — so unlike the CVE gate
 * in `audit-dependencies.ts`, which posts the lockfile to npm's advisory
 * endpoint and therefore cannot be in a pre-push hook, this one belongs in
 * `bun run check`.
 *
 * ─── Licensing: why a devDependency here is not a licence question ───
 *
 * `squawk-cli` and its platform binaries are `(Apache-2.0 OR MIT)` as of
 * 2.64.0 (`npm view squawk-cli@2.64.0 license`). squawk WAS GPL-3.0 and
 * relicensed at 2.12.0 — verified by walking the published versions:
 * 2.11.0 → `GPL-3.0`, 2.12.0 → `(Apache-2.0 OR MIT)`. So the pinned version is
 * Apache-compatible outright, and the analysis below is belt-and-braces rather
 * than the load-bearing argument it would have been under GPL-3.0: squawk is
 * invoked as a SEPARATE PROCESS, never linked, never redistributed; it is a
 * root devDependency, and devDependencies are not installed by consumers of a
 * published package. The three packages this repo publishes —
 * `@appstrate/core`, `@appstrate/afps-shared`, `apps/cli` — do not name it in
 * any dependency field (checked 2026-09-08), and a root devDependency is not
 * part of any of their published trees.
 *
 * ─── Supply chain ────────────────────────────────────────────────────
 *
 * No postinstall script, and no download at install time. The launcher
 * (`js/index.js`, 60 lines, read in full) `require.resolve`s a per-platform
 * package and spawns the binary out of it; the binaries ship in ordinary npm
 * tarballs declared as `optionalDependencies` with `os`/`cpu` fields, so bun
 * installs exactly one — `@squawk-cli/darwin-arm64` here, verified 2026-09-08
 * by listing `node_modules/.bun/`. The version is pinned exactly (no `^`) in
 * the root `package.json` for the same reason CI pins action SHAs.
 *
 * ─── `--assume-in-transaction` is a FACT about this repo ─────────────
 *
 * drizzle wraps the whole pending batch in one transaction. That is not an
 * assumption: it is why not one migration in this directory uses
 * `CONCURRENTLY`, and `0041`'s header states the mechanism — "Postgres forbids
 * CREATE INDEX CONCURRENTLY inside a transaction block, and the whole pending
 * batch runs inside one transaction". Telling squawk so changes its verdict
 * substantially, measured 2026-09-08 over all 56 files: 881 findings without
 * the flag, 260 with it, because rules like `prefer-robust-stmts` (341
 * findings, all of them gone) are about a partially applied migration — which
 * a transaction makes impossible.
 *
 * ─── Rule set ────────────────────────────────────────────────────────
 *
 * squawk's defaults, minus `EXCLUDED_RULES`, plus none of its opt-in rules.
 * A typo or a removed rule in that list is not a silent widening: squawk
 * validates rule names and exits 2 with
 * `error: invalid value '…' for '--exclude <rule>': invalid rule name …`
 * (measured 2026-09-08), which `parseFindings` reports as a tool failure.
 *
 * Usage: bun scripts/lint-migrations.ts
 */

import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { trackedFiles } from "./lib/tracked-files.ts";

const REPO_ROOT = join(import.meta.dir, "..");

/**
 * Rules this repo does not enforce, and cannot fix by enforcing.
 *
 * Both pairs are impossibilities rather than preferences, and both are settled
 * by a document already in the tree. A rule kept enabled whose only available
 * remedy is "add a baseline entry" would turn `BASELINE` from a record of
 * immutable history into a growing exemption list — the one thing it must not
 * become.
 *
 * They are excluded at the squawk level rather than baselined so the exclusion
 * applies to NEW migrations too, which is the point: a new migration creating
 * an index is not a finding, because the alternative squawk recommends does
 * not exist here.
 */
const EXCLUDED_RULES: readonly string[] = [
  // `CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY` cannot run inside a
  // transaction block, and every migration here runs inside one — see
  // `--assume-in-transaction` above and `0041`'s header for the mechanism.
  // `--assume-in-transaction` does NOT suppress these two on its own (43 + 24
  // findings survive it, measured 2026-09-08), so they are named here.
  //
  // This leaves no hole, and that is checked rather than assumed: squawk's
  // INVERSE rule, `ban-concurrent-index-creation-in-transaction`, stays on and
  // is what actually applies here. A file with `SET LOCAL lock_timeout` /
  // `statement_timeout` and one `CREATE INDEX CONCURRENTLY` reports
  // `ban-concurrent-index-creation-in-transaction: While regular index creation
  // can happen inside a transaction, this is not allowed when the CONCURRENTLY
  // option is used` (measured 2026-09-08). So the mistake a developer can make
  // in this repo is caught; the one they cannot avoid is not reported.
  "require-concurrent-index-creation",
  "require-concurrent-index-deletion",
  // `docs/NO_TRANSITIONAL_CODE.md` MANDATES the thing these two ban: a retired
  // column or table is dropped, in the migration that retires it, with no
  // compatibility window ("How to retire something correctly", step 1). The 19
  // `ban-drop-column` and 3 `ban-drop-table` findings across this history are
  // all deliberate, headered drops. The hazard the rules guard against — an old
  // reader still selecting the column during a rolling deploy — does not arise:
  // the deploy replaces every container at once.
  "ban-drop-column",
  "ban-drop-table",
];

/**
 * One accepted finding: a migration NAME (basename without `.sql`) and the
 * squawk rule it trips.
 *
 * ─── Why there is no expiry, unlike `ACCEPTED_ADVISORIES` ────────────
 *
 * An accepted CVE expires because the acceptance is a bet on the future —
 * upstream will ship a fix, the unreachable call path may become reachable —
 * and the only thing that reliably forces the re-decision is the gate going red
 * on a chosen morning. None of that applies here. A drizzle migration is
 * applied history: it has already run on production, it is never edited, and no
 * upgrade to anything can make it not have taken the lock it took. An expiry
 * date on these entries would come due with no lawful remedy — the only way to
 * clear it would be to write a new, later date. So there is none, deliberately;
 * do not copy the mechanism from `audit-dependencies.ts` where it makes no
 * sense.
 *
 * ─── Why (file, rule) and not just the file ──────────────────────────
 *
 * Keyed on the pair, and checked in BOTH directions by `reviewFindings`: an
 * entry matching no live finding fails the gate. Exempting a whole FILE would
 * be less to write and would also excuse a hazard class that was never in it.
 * Line numbers are deliberately NOT part of the key — they are the one part of
 * a finding that churns, and a file that cannot change cannot churn them
 * meaningfully.
 *
 * ─── There is no `--update-baseline` ─────────────────────────────────
 *
 * On purpose. A regeneration flag on a list whose entries can only be
 * historical is a way to clear a finding in a NEW migration without reading it.
 * When a squawk upgrade changes a rule name, the gate prints the exact lines to
 * delete, and a human pastes the replacements.
 *
 * Generated 2026-09-08 from `squawk --assume-in-transaction --exclude=…
 * --reporter json packages/db/drizzle/*.sql`: 171 findings, 106 (file, rule)
 * pairs across 47 of the 56 files.
 */
export type BaselineEntry = readonly [migration: string, rule: string];

export const BASELINE: readonly BaselineEntry[] = [
  ["0000_init", "identifier-too-long"],
  ["0000_init", "prefer-bigint-over-int"],
  ["0000_init", "prefer-identity"],
  ["0000_init", "require-lock-timeout"],
  ["0000_init", "require-statement-timeout"],
  ["0001_drop_credential_proxy_usage_cost_usd", "require-lock-timeout"],
  ["0001_drop_credential_proxy_usage_cost_usd", "require-statement-timeout"],
  ["0002_fold_webhooks_tables", "require-lock-timeout"],
  ["0002_fold_webhooks_tables", "require-statement-timeout"],
  ["0003_fold_oidc_tables", "require-lock-timeout"],
  ["0003_fold_oidc_tables", "require-statement-timeout"],
  ["0004_nasty_snowbird", "require-lock-timeout"],
  ["0004_nasty_snowbird", "require-statement-timeout"],
  ["0005_integration_refresh_failure_tracking", "prefer-bigint-over-int"],
  ["0005_integration_refresh_failure_tracking", "require-lock-timeout"],
  ["0005_integration_refresh_failure_tracking", "require-statement-timeout"],
  ["0006_mcp_oauth_resources", "require-lock-timeout"],
  ["0006_mcp_oauth_resources", "require-statement-timeout"],
  ["0007_model_provider_refresh_failure_tracking", "prefer-bigint-over-int"],
  ["0007_model_provider_refresh_failure_tracking", "require-lock-timeout"],
  ["0007_model_provider_refresh_failure_tracking", "require-statement-timeout"],
  ["0008_drop_oidc_encryption_key_version", "require-lock-timeout"],
  ["0008_drop_oidc_encryption_key_version", "require-statement-timeout"],
  ["0009_perf_indexes", "require-lock-timeout"],
  ["0009_perf_indexes", "require-statement-timeout"],
  ["0010_credential_available_models", "require-lock-timeout"],
  ["0010_credential_available_models", "require-statement-timeout"],
  ["0011_aromatic_korvac", "require-lock-timeout"],
  ["0011_aromatic_korvac", "require-statement-timeout"],
  ["0012_amusing_gressill", "require-lock-timeout"],
  ["0012_amusing_gressill", "require-statement-timeout"],
  ["0013_notifications", "require-lock-timeout"],
  ["0013_notifications", "require-statement-timeout"],
  ["0014_uneven_charles_xavier", "require-lock-timeout"],
  ["0014_uneven_charles_xavier", "require-statement-timeout"],
  ["0015_greedy_ulik", "require-lock-timeout"],
  ["0015_greedy_ulik", "require-statement-timeout"],
  ["0016_burly_hawkeye", "prefer-bigint-over-int"],
  ["0016_burly_hawkeye", "prefer-identity"],
  ["0016_burly_hawkeye", "prefer-timestamp-tz"],
  ["0016_burly_hawkeye", "require-lock-timeout"],
  ["0016_burly_hawkeye", "require-statement-timeout"],
  ["0017_panoramic_lockjaw", "require-lock-timeout"],
  ["0017_panoramic_lockjaw", "require-statement-timeout"],
  ["0018_white_captain_universe", "constraint-missing-not-valid"],
  ["0018_white_captain_universe", "require-lock-timeout"],
  ["0018_white_captain_universe", "require-statement-timeout"],
  ["0019_flat_iron_patriot", "changing-column-type"],
  ["0019_flat_iron_patriot", "prefer-bigint-over-int"],
  ["0019_flat_iron_patriot", "require-lock-timeout"],
  ["0019_flat_iron_patriot", "require-statement-timeout"],
  ["0020_sharp_the_fury", "require-lock-timeout"],
  ["0020_sharp_the_fury", "require-statement-timeout"],
  ["0023_attribution_llm_usage", "require-lock-timeout"],
  ["0023_attribution_llm_usage", "require-statement-timeout"],
  ["0024_blushing_nebula", "require-lock-timeout"],
  ["0024_blushing_nebula", "require-statement-timeout"],
  ["0025_bent_moonstone", "require-lock-timeout"],
  ["0025_bent_moonstone", "require-statement-timeout"],
  ["0026_next_mathemanic", "require-lock-timeout"],
  ["0026_next_mathemanic", "require-statement-timeout"],
  ["0027_documents_hardening", "prefer-bigint-over-int"],
  ["0027_documents_hardening", "require-lock-timeout"],
  ["0027_documents_hardening", "require-statement-timeout"],
  ["0028_detach_llm_usage_context", "require-lock-timeout"],
  ["0028_detach_llm_usage_context", "require-statement-timeout"],
  ["0029_documents_tenant_integrity", "require-lock-timeout"],
  ["0029_documents_tenant_integrity", "require-statement-timeout"],
  ["0031_jittery_satana", "constraint-missing-not-valid"],
  ["0031_jittery_satana", "require-lock-timeout"],
  ["0031_jittery_satana", "require-statement-timeout"],
  ["0032_sour_marvel_zombies", "require-lock-timeout"],
  ["0032_sour_marvel_zombies", "require-statement-timeout"],
  ["0033_green_jimmy_woo", "adding-foreign-key-constraint"],
  ["0033_green_jimmy_woo", "constraint-missing-not-valid"],
  ["0033_green_jimmy_woo", "require-lock-timeout"],
  ["0033_green_jimmy_woo", "require-statement-timeout"],
  ["0034_mysterious_fabian_cortez", "require-lock-timeout"],
  ["0034_mysterious_fabian_cortez", "require-statement-timeout"],
  ["0035_smiling_ricochet", "require-lock-timeout"],
  ["0035_smiling_ricochet", "require-statement-timeout"],
  ["0036_calm_landau", "require-lock-timeout"],
  ["0036_calm_landau", "require-statement-timeout"],
  ["0037_clumsy_mandrill", "constraint-missing-not-valid"],
  ["0037_clumsy_mandrill", "require-lock-timeout"],
  ["0037_clumsy_mandrill", "require-statement-timeout"],
  ["0038_young_cassandra_nova", "constraint-missing-not-valid"],
  ["0038_young_cassandra_nova", "require-lock-timeout"],
  ["0038_young_cassandra_nova", "require-statement-timeout"],
  ["0039_unique_nebula", "require-statement-timeout"],
  ["0040_config_into_input", "require-lock-timeout"],
  ["0040_config_into_input", "require-statement-timeout"],
  ["0041_restore_squash_indexes", "require-statement-timeout"],
  ["0042_drop_document_presentation", "require-lock-timeout"],
  ["0042_drop_document_presentation", "require-statement-timeout"],
  ["0044_finish_file_rename", "require-lock-timeout"],
  ["0044_finish_file_rename", "require-statement-timeout"],
  ["0045_drop_integration_refresh_failure_timestamp", "require-lock-timeout"],
  ["0045_drop_integration_refresh_failure_timestamp", "require-statement-timeout"],
  ["0047_timestamptz_oidc_webhooks", "changing-column-type"],
  ["0049_drop_credential_proxy_usage", "require-statement-timeout"],
  ["0051_closed_vocabularies", "changing-column-type"],
  ["0053_applications_to_spaces", "require-lock-timeout"],
  ["0053_applications_to_spaces", "require-statement-timeout"],
  ["0054_drop_chat_message_parent_and_format", "require-lock-timeout"],
  ["0054_drop_chat_message_parent_and_format", "require-statement-timeout"],
];

/** One squawk finding, as `--reporter json` emits it. */
export interface Finding {
  /** Path as passed on argv — repo-relative, since the scan runs from the root. */
  file: string;
  /** 0-based. Printed as `line + 1`, which is what the tty reporter shows. */
  line: number;
  message: string;
  rule_name: string;
}

/** The migration name a finding belongs to — the `BASELINE` key. */
function migrationOf(finding: Finding): string {
  return basename(finding.file, ".sql");
}

/**
 * Parse `squawk --reporter json` stdout.
 *
 * squawk exits 1 for ANY finding, baselined or not, and 2 for a bad rule name
 * with nothing on stdout at all — so the exit code is not a verdict this gate
 * can reuse, exactly as `bun audit`'s is not in `audit-dependencies.ts`. A
 * failure of the COMMAND therefore shows up here, as stdout that is not the
 * JSON array squawk promises.
 */
export function parseFindings(raw: string, stderr: string, exitCode: number): Finding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `squawk did not emit JSON (exit ${exitCode}).\nstdout: ${raw.trim() || "(empty)"}\n` +
        `stderr: ${stderr.trim() || "(empty)"}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`squawk --reporter json returned ${typeof parsed}, expected an array.`);
  }
  return parsed as Finding[];
}

/** What one review pass concluded, with the counts that prove it read something. */
export interface LintReview {
  problems: string[];
  files: number;
  findings: number;
  baselined: number;
  fresh: number;
  stale: number;
}

/**
 * Decide which findings are new and which baseline entries have gone stale.
 * Pure — `main` feeds it a real squawk run, the tests feed it fixtures.
 *
 * A fresh finding is reported with every line it occurs on: the PAIR is what is
 * accepted or rejected, but the LINE is what the developer edits.
 */
export function reviewFindings(
  findings: readonly Finding[],
  baseline: readonly BaselineEntry[],
  files: number,
): LintReview {
  const accepted = new Set(baseline.map(([m, r]) => `${m} ${r}`));
  const matched = new Set<string>();

  const fresh = new Map<string, Finding[]>();
  let baselined = 0;

  for (const finding of findings) {
    const key = `${migrationOf(finding)} ${finding.rule_name}`;
    if (accepted.has(key)) {
      matched.add(key);
      baselined++;
      continue;
    }
    const bucket = fresh.get(key);
    if (bucket === undefined) fresh.set(key, [finding]);
    else bucket.push(finding);
  }

  const problems: string[] = [];

  for (const [, group] of [...fresh].sort(([a], [b]) => a.localeCompare(b))) {
    const first = group[0];
    if (first === undefined) continue;
    problems.push(
      `${first.file} trips \`${first.rule_name}\` (${group.length} time(s)):\n` +
        group.map((f) => `    line ${f.line + 1}: ${f.message}`).join("\n") +
        `\n    → https://squawkhq.com/docs/${first.rule_name}`,
    );
  }

  // Both directions. An entry that no longer matches a live finding is not
  // harmless: it reads as an accepted hazard production still carries, and it
  // would silently absolve a rule that squawk had stopped emitting.
  const dead = baseline.filter(([m, r]) => !matched.has(`${m} ${r}`));
  if (dead.length > 0) {
    problems.push(
      `${dead.length} BASELINE entr(y|ies) in scripts/lint-migrations.ts match no finding any ` +
        `more:\n` +
        dead.map(([m, r]) => `    ["${m}", "${r}"],`).join("\n") +
        `\n    The migration left the directory, or squawk stopped emitting that rule. Delete ` +
        `the line(s) above.`,
    );
  }

  return {
    problems,
    files,
    findings: findings.length,
    baselined,
    fresh: [...fresh.values()].reduce((n, g) => n + g.length, 0),
    stale: dead.length,
  };
}

/** The one-line verdict, with the counts that distinguish it from a no-op run. */
export function summaryLine(review: LintReview): string {
  return (
    `${review.files} migration(s) linted — ${review.findings} finding(s): ` +
    `${review.baselined} baselined, ${review.fresh} new, ` +
    `${review.stale} stale baseline entry(ies).`
  );
}

/**
 * Where `bun install` puts the squawk launcher. Root-only: `squawk-cli` is a
 * root devDependency, so there is one place for it to be.
 */
const SQUAWK_BIN = join(REPO_ROOT, "node_modules/.bin/squawk");

// Guarded so `scripts/test/lint-migrations.test.ts` can import the pure
// reviewers without spawning squawk — same pattern as
// `verify-no-migration-dml.ts`.
if (import.meta.main) {
  if (!existsSync(SQUAWK_BIN)) {
    throw new Error(`squawk not found at ${SQUAWK_BIN}. Run \`bun install\`.`);
  }

  // Discovered, not listed: `git ls-files`, the house source of "which files
  // exist" (`scripts/lib/tracked-files.ts`). `"fail"` because this gate's file
  // list IS its coverage — quietly linting one migration fewer would still
  // print a tick.
  const migrations = trackedFiles(["packages/db/drizzle/*.sql"], "migration", "fail");

  const run = Bun.spawnSync({
    cmd: [
      SQUAWK_BIN,
      "--assume-in-transaction",
      `--exclude=${EXCLUDED_RULES.join(",")}`,
      "--reporter",
      "json",
      ...migrations,
    ],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });

  const findings = parseFindings(run.stdout.toString(), run.stderr.toString(), run.exitCode);
  const review = reviewFindings(findings, BASELINE, migrations.length);

  for (const p of review.problems) console.error(`❌ ${p}`);

  if (review.problems.length === 0) {
    console.log(`✅ migration lock safety — ${summaryLine(review)}`);
    process.exit(0);
  }

  console.error(
    `\n❌ migration lock safety — ${summaryLine(review)}\n` +
      `Every migration in packages/db/drizzle/ replays on production inside ONE transaction, so ` +
      `a heavy lock is held until the batch commits. Fix the statement — see the rule page ` +
      `above — or, when it is genuinely unavoidable, bound it the way 0050 does: SET LOCAL ` +
      `lock_timeout (bounds acquisition) and SET LOCAL statement_timeout (bounds execution).\n` +
      `BASELINE is applied history and must not grow.`,
  );
  process.exit(1);
}
