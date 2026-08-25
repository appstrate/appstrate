// SPDX-License-Identifier: Apache-2.0

/**
 * Verify that compose files don't re-declare env defaults that are
 * already defined in `packages/env/src/index.ts` (the Zod schema).
 *
 * The duplication risk is real: see #513 (`MODULES` drifted in compose
 * from the schema, and every CLI self-host install shipped with zero
 * model providers for weeks). This guard catches the same class of bug
 * at PR time.
 *
 * The table + extraction + analysis live in
 * `apps/cli/src/lib/compose-defaults.ts` so this PR-time guard and the
 * runtime checks (`appstrate doctor` / `appstrate install
 * --upgrade-compose`, issue #515) share one source of truth and can
 * never disagree about what counts as a duplication.
 *
 * Usage: bun scripts/verify-compose-defaults.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeComposeDefaults,
  SCHEMA_SOURCE,
  type ComposeDefaultForm,
  type ComposeFinding,
} from "../apps/cli/src/lib/compose-defaults.ts";

const REPO_ROOT = join(import.meta.dir, "..");

/**
 * Every tracked compose file, discovered — not enumerated.
 *
 * A hardcoded list only covers the files someone remembered to add, and this
 * one twice did not: it scanned the four `examples/self-hosting/` files while
 * skipping both root ones, then both root ones while skipping the two under
 * `test/setup/`. Discovery removes the remembering step — a NEW compose file
 * is covered the day it is committed, which is the property the list could
 * never have.
 *
 * `git ls-files` is deliberately the source of truth for "tracked": the
 * untracked, local-only `docker-compose.override.yml` is a developer's own
 * machine and is not this gate's business, and it stays out for free.
 */
function trackedComposeFiles(): string[] {
  const result = Bun.spawnSync({
    cmd: ["git", "ls-files", "-z", "--", "*docker-compose*.yml", "*docker-compose*.yaml"],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ls-files failed (exit ${result.exitCode}): ${result.stderr.toString().trim()}`,
    );
  }
  const files = result.stdout.toString().split("\0").filter(Boolean).sort();
  if (files.length === 0) {
    throw new Error("git ls-files matched no compose file — the gate would pass vacuously.");
  }
  return files;
}

const COMPOSE_FILES = trackedComposeFiles();

/**
 * The repair differs by shape, and printing one instruction for both would
 * send half the readers to the wrong edit: an interpolation still lets the
 * host environment win and is fixed by dropping the `=${VAR:-default}` tail,
 * while a literal pins the value outright and has to go away entirely.
 */
const REPAIR: Record<ComposeDefaultForm, string> = {
  interpolation: "fix: drop the `=${VAR:-default}` tail, leaving a bare passthrough entry.",
  literal: "fix: delete the line — the value is PINNED, so the schema default never applies.",
};

/** A finding tagged with the file it came from (the lib is per-content). */
type FileFinding = ComposeFinding & { file: string };

function main(): number {
  const findings: FileFinding[] = [];

  for (const file of COMPOSE_FILES) {
    const content = readFileSync(join(REPO_ROOT, file), "utf-8");
    for (const finding of analyzeComposeDefaults(content)) {
      findings.push({ ...finding, file });
    }
  }

  if (findings.length === 0) {
    console.log(
      `\x1b[32m✓\x1b[0m verify-compose-defaults: no duplicated env defaults across ${COMPOSE_FILES.length} compose files.`,
    );
    return 0;
  }

  const duplicates = findings.filter((f) => f.kind === "duplicate");
  const drifts = findings.filter((f) => f.kind === "allowlist-drift");

  console.error(
    `\x1b[31m✗\x1b[0m verify-compose-defaults: ${findings.length} issue(s) found ` +
      `(${duplicates.length} duplicates, ${drifts.length} ALLOWLIST drift).\n`,
  );

  if (duplicates.length > 0) {
    console.error(`\x1b[1m── Class 1: duplicates code default ──\x1b[0m`);
    console.error(
      `Compose files should not mirror defaults already defined in ${SCHEMA_SOURCE}.\n` +
        `Drop the YAML default and rely on the Zod schema's single source of truth — or, if the\n` +
        `override is deliberate, add the variable to the ALLOWLIST in\n` +
        `apps/cli/src/lib/compose-defaults.ts with a documented reason.\n` +
        `This was the root cause of #513 (MODULES drift → no model providers).\n`,
    );
    for (const f of duplicates) {
      console.error(
        `  \x1b[1m${f.file}:${f.line}\x1b[0m  ${f.varName}=${JSON.stringify(f.yamlDefault)}`,
      );
      console.error(
        `    \x1b[33m[duplicates code default]\x1b[0m in ${SCHEMA_SOURCE} (${f.varName}: ${JSON.stringify(f.codeDefault)})`,
      );
      console.error(`    ${REPAIR[f.form]}`);
    }
    console.error("");
  }

  if (drifts.length > 0) {
    console.error(`\x1b[1m── Class 2: ALLOWLIST drift ──\x1b[0m`);
    console.error(
      `The ALLOWLIST entry's recorded yamlDefault no longer matches the compose file.\n` +
        `Either update the ALLOWLIST entry in apps/cli/src/lib/compose-defaults.ts (when the\n` +
        `change is intentional — also revise the documented reason) or revert the compose\n` +
        `change. Silent drift would let an intentional override quietly change semantics.\n`,
    );
    for (const f of drifts) {
      console.error(
        `  \x1b[1m${f.file}:${f.line}\x1b[0m  ${f.varName}=${JSON.stringify(f.yamlDefault)}`,
      );
      console.error(
        `    \x1b[33m[ALLOWLIST drift]\x1b[0m expected yamlDefault=${JSON.stringify(f.expectedYamlDefault)} ` +
          `but compose file has ${JSON.stringify(f.yamlDefault)}`,
      );
    }
    console.error("");
  }

  return 1;
}

process.exit(main());
