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
import { envSchema } from "../packages/env/src/index.ts";
import {
  analyzeComposeDefaults,
  CODE_DEFAULTS,
  extractComposeDefaults,
  SCHEMA_SOURCE,
  type ComposeDefaultForm,
  type ComposeFinding,
} from "../apps/cli/src/lib/compose-defaults.ts";
import { COMPOSE_GLOBS, trackedFiles } from "./lib/tracked-files.ts";

const REPO_ROOT = join(import.meta.dir, "..");

/**
 * Does this field's schema supply a value the environment did not?
 *
 * Three Zod nodes do: `.default()`, `.prefault()` and `.catch()`. From
 * compose's point of view they are indistinguishable — the schema produces the
 * value, so a YAML line pinning the same one is the #513 duplication. `.catch`
 * and `.prefault` appear zero times in the schema today; they are here so that
 * the day one does, the gate does not silently stop seeing that variable.
 *
 * The recursion exists for ONE node: `.transform()` wraps its subject in a
 * pipe, so the helper-wrapped fields (`boolEnv("false")`, `jsonEnv<T>("[]")` —
 * `z.string().default(d).transform(…)`) present as `pipe`, with the default on
 * the `in` side. Measured 2026-08-26: 47 of the 67 defaults sit on the top
 * node and 20 sit under a pipe, so reading only the top node would under-report
 * by 20. Two further pipes carry no default at all (`PLATFORM_API_URL`,
 * whose transform maps `""` to `undefined`), which is why the recursion asks
 * the `in` side rather than assuming a pipe implies a default.
 *
 * What this deliberately does NOT see: a value materialised inside the
 * transform body itself (`.transform((v) => v ?? "512")`). Recognising that
 * needs the function evaluated. A variable defaulted only that way is not
 * reported as defaulted, and a compose file pinning its value passes this gate.
 * A known hole, not a covered case.
 */
export function suppliesValue(schema: unknown): boolean {
  const def = (schema as { _def?: { type?: string; in?: unknown } } | null)?._def;
  if (!def) return false;
  if (def.type === "default" || def.type === "prefault" || def.type === "catch") return true;
  if (def.type === "pipe") return suppliesValue(def.in);
  return false;
}

/**
 * The env vars `packages/env/src/index.ts` declares, and which of them the
 * schema gives a value to — read off the schema OBJECT, not its source text.
 *
 * This used to parse the file as text, anchoring key names on exactly four
 * spaces of indent. That anchor was fail-OPEN — reformatting `z.object({ … })`
 * emptied both sets, and an empty set produces no findings and a green tick —
 * so three vacuity floors and a self-check grew around it to notice the
 * degradation, and that machinery became most of this file.
 *
 * Importing the schema removes the failure mode instead of instrumenting it: a
 * rename is a TypeScript error, a broken import throws at load, and there is no
 * formatting of the source that changes what `envSchema.shape` contains. The
 * two functions agreed exactly on today's schema when the swap was made
 * (99 keys, 67 defaulted, identical member-for-member), so this is a
 * simplification and not a change of verdict.
 *
 * Importing `@appstrate/env` has no import-time side effect: `createEnvGetter`
 * is lazy, so nothing reads `process.env` or throws at module scope.
 */
export function readSchemaDefaults(): { keys: Set<string>; defaulted: Set<string> } {
  const keys = new Set<string>();
  const defaulted = new Set<string>();
  for (const [name, field] of Object.entries(envSchema.shape)) {
    keys.add(name);
    if (suppliesValue(field)) defaulted.add(name);
  }
  return { keys, defaulted };
}

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
 * The discovery itself (and the reason it reads the git index rather than the
 * filesystem — the untracked, local-only `docker-compose.override.yml` is a
 * developer's own machine and not this gate's business) lives in
 * `scripts/lib/tracked-files.ts`, shared with the two sibling gates.
 *
 * `"fail"`, not `"skip"`, and that is the whole point of the argument being
 * required. This gate's file list IS its coverage: every file it does not read
 * is a compose file whose defaults nothing compared. Measured with the silent
 * skip in place, `rm docker-compose.yml` — the root file this gate exists for —
 * gave `✓ … across 8 compose files` and exit 0, the drop from 9 to 8 being the
 * only evidence anywhere that the gate had stopped looking. Under `"fail"` the
 * same deletion names the file and exits non-zero. `lint.ts` and
 * `lint-manifest-casing.ts` take the other answer, for their own stated reason.
 */
const COMPOSE_FILES = trackedFiles(COMPOSE_GLOBS, "compose file", "fail");

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

/**
 * A compose file pins a default for a variable the schema gives a default to,
 * and `CODE_DEFAULTS` does not name it — so nothing compared the two values.
 *
 * This is a finding ABOUT THE GATE, not about the compose file: the YAML value
 * may well be correct. What is wrong is that it was never checked. Reporting it
 * as an error is the point — silence here is exactly how a gate ends up
 * measuring 3 of the 17 variables in front of it and printing a tick.
 */
interface TableGapFinding {
  file: string;
  line: number;
  varName: string;
  yamlDefault: string;
}

/**
 * The gap findings in one compose file's text. Pure — content in, findings out,
 * so `scripts/test/verify-compose-defaults.test.ts` can hold a synthetic
 * compose against it without a tracked file or a git write.
 */
export function findTableGaps(
  content: string,
  schemaDefaulted: ReadonlySet<string>,
): Omit<TableGapFinding, "file">[] {
  const gaps: Omit<TableGapFinding, "file">[] = [];
  for (const match of extractComposeDefaults(content)) {
    if (match.varName in CODE_DEFAULTS) continue;
    if (!schemaDefaulted.has(match.varName)) continue;
    gaps.push({ line: match.line, varName: match.varName, yamlDefault: match.yamlDefault });
  }
  return gaps;
}

function main(): number {
  const findings: FileFinding[] = [];
  const gaps: TableGapFinding[] = [];

  const { keys: schemaKeys, defaulted: schemaDefaulted } = readSchemaDefaults();

  for (const file of COMPOSE_FILES) {
    const content = readFileSync(join(REPO_ROOT, file), "utf-8");
    for (const finding of analyzeComposeDefaults(content)) {
      findings.push({ ...finding, file });
    }
    for (const gap of findTableGaps(content, schemaDefaulted)) {
      gaps.push({ ...gap, file });
    }
  }

  if (findings.length === 0 && gaps.length === 0) {
    // What was compared, so a reader can tell at a glance which two populations
    // met: the compose files scanned, and the schema vars they were checked
    // against. Not a diagnostic — nothing here is load-bearing for correctness.
    console.log(
      `\x1b[32m✓\x1b[0m verify-compose-defaults: no duplicated env defaults across ${COMPOSE_FILES.length} compose files ` +
        `(${schemaDefaulted.size} of ${SCHEMA_SOURCE}'s ${schemaKeys.size} env vars carry a schema default; ` +
        `all compose-pinned vars covered by the table).`,
    );
    return 0;
  }

  const duplicates = findings.filter((f) => f.kind === "duplicate");
  const drifts = findings.filter((f) => f.kind === "allowlist-drift");

  console.error(
    `\x1b[31m✗\x1b[0m verify-compose-defaults: ${findings.length + gaps.length} issue(s) found ` +
      `(${duplicates.length} duplicates, ${drifts.length} ALLOWLIST drift, ${gaps.length} table gap).\n`,
  );

  if (gaps.length > 0) {
    console.error(`\x1b[1m── Class 3: variable not covered by CODE_DEFAULTS ──\x1b[0m`);
    console.error(
      `These compose lines pin a default for a variable that ${SCHEMA_SOURCE} ALSO gives a\n` +
        `default to — but CODE_DEFAULTS in apps/cli/src/lib/compose-defaults.ts does not name it,\n` +
        `so the two values were never compared. The YAML may be fine; the gate simply was not\n` +
        `looking, which is the #513 failure mode one level up.\n` +
        `Fix: add the variable to CODE_DEFAULTS with the schema's default value (and, if the\n` +
        `compose value deliberately differs, an ALLOWLIST entry with the reason).\n`,
    );
    for (const g of gaps) {
      console.error(
        `  \x1b[1m${g.file}:${g.line}\x1b[0m  ${g.varName}=${JSON.stringify(g.yamlDefault)}`,
      );
      console.error(
        `    \x1b[33m[not in CODE_DEFAULTS]\x1b[0m ${SCHEMA_SOURCE} declares a default for ${g.varName}`,
      );
    }
    console.error("");
  }

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

// Guarded so the test file can import the pure helpers above without the gate
// exiting the test process on import — same pattern as check-index-drift.ts.
if (import.meta.main) {
  process.exit(main());
}
