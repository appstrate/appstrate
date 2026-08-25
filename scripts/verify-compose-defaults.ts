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
  CODE_DEFAULTS,
  extractComposeDefaults,
  SCHEMA_SOURCE,
  type ComposeDefaultForm,
  type ComposeFinding,
} from "../apps/cli/src/lib/compose-defaults.ts";
import { COMPOSE_GLOBS, trackedFiles } from "./lib/tracked-files.ts";

const REPO_ROOT = join(import.meta.dir, "..");

/**
 * The Zod combinators that make a variable's value come from the schema rather
 * than from the environment. Used for BOTH halves of the scan — a key's own
 * block and a helper's body — so the two can never recognise different sets.
 */
const DEFAULTING = /\.(?:default|catch|prefault)\(/;

/**
 * The variable names `packages/env/src/index.ts` gives a default to, read out
 * of the schema source.
 *
 * This is NOT an attempt to extract default VALUES — that really is entangled
 * with transforms and refinements, which is the reason `CODE_DEFAULTS` is
 * hand-maintained and stays so. Extracting the NAMES is a far weaker problem,
 * and it is enough to turn the table's blind spot into an error.
 *
 * The blind spot, measured: 14 schema vars carrying a `.default()` were absent
 * from `CODE_DEFAULTS` — `CONNECT_SESSION_TTL_MS`, `RUN_WAIT_POLL_INTERVAL_MS`,
 * `MODULE_CONTRACT_ENFORCE`, `WORKSPACE_INIT_IMAGE`, `WORKSPACE_TMPFS_SIZE_MB`,
 * `WORKSPACE_MAX_FILES_BYTES`, `UPLOAD_RETENTION_HOURS`,
 * `UPLOAD_MAX_ACTIVE_PER_ACTOR`, `UPLOAD_STAGING_MAX_BYTES_PER_ORG`,
 * `RUN_MAX_FILES`, `FILE_MAX_BYTES`, `RUN_MAX_OUTPUT_BYTES`,
 * `STORAGE_DELETION_WORKER_INTERVAL_MS`, `AUTH_SESSION_COOKIE_CACHE_SECONDS`.
 * `analyzeComposeDefaults` skips any variable the table does not name
 * (`codeDefault === undefined` → `continue`), so a compose file pinning
 * `WORKSPACE_TMPFS_SIZE_MB=${WORKSPACE_TMPFS_SIZE_MB:-512}` at exactly the
 * schema default passed clean — the #513 bug, in a variable the table forgot.
 * A gate whose coverage is a list somebody has to remember to extend reports on
 * what it remembers, not on what is there.
 *
 * Three shapes count as a default:
 *   - a literal `.default(...)` in the key's own block;
 *   - `.catch(...)` / `.prefault(...)` — Zod's other two "produce this value
 *     instead of failing / instead of `undefined`" combinators. From compose's
 *     point of view they are indistinguishable from `.default()`: the schema
 *     supplies the value, so a YAML line pinning the same one is the same #513
 *     duplication. Neither appears in the schema today (measured 2026-08-25:
 *     zero occurrences); they are here so that the day one does, the gate does
 *     not silently stop seeing that variable;
 *   - a call to a schema helper that applies one internally (`jsonEnv("[]")`,
 *     `boolEnv("false")`). Those helpers are DISCOVERED, not listed: a
 *     top-level declaration above the schema whose body contains one of the
 *     three markers is one. 16 of the table's entries are helper-wrapped, so a
 *     literal-only scan would have under-reported by 16 and quietly restored a
 *     smaller version of the same hole. Both declaration forms are scanned —
 *     `const helper = …` and `function helper(…) { … }`. The schema uses only
 *     the arrow-const form today; the `function` form was invisible before, and
 *     "the extractor works as long as nobody uses a function declaration" is
 *     not a property worth depending on.
 *
 * ─── What this deliberately does NOT see ─────────────────────────────
 *
 * A default supplied inside a transform — `.transform((v) => v ?? "512")`, or
 * any other expression that materialises a value at parse time. Recognising it
 * needs the transform body evaluated, or at minimum a real TS parse plus a
 * data-flow judgement about which returns are defaults; there is no cheap
 * textual rule, and a guessed one would report on shapes it does not
 * understand. So: a variable defaulted only that way is NOT reported as
 * defaulted, and a compose file pinning its value passes this gate. That is a
 * known hole, not a covered case.
 *
 * `assertExtractorStillWorks` below narrows the risk but does not close it —
 * see its own comment for exactly what it can and cannot catch.
 */
export function readSchemaDefaults(): { keys: Set<string>; defaulted: Set<string> } {
  return extractSchemaDefaults(readFileSync(join(REPO_ROOT, SCHEMA_SOURCE), "utf-8"));
}

/**
 * The extraction itself — schema TEXT in, key sets out.
 *
 * Pure, for the same reason `findTableGaps` is: `scripts/test/` can hold a
 * synthetic schema against it and assert each defaulting form is recognised,
 * without the assertion depending on how `packages/env/src/index.ts` happens to
 * be written today.
 */
export function extractSchemaDefaults(source: string): {
  keys: Set<string>;
  defaulted: Set<string>;
} {
  const lines = source.split("\n");

  // Where the schema object starts — helper declarations are the top-level
  // declarations BEFORE it. (`envSchema` itself contains `.default(` too and
  // would otherwise be collected; it is never called from a key block, so this
  // is tidiness rather than a fix.)
  const schemaStart = lines.findIndex((l) => l.startsWith("const envSchema"));
  if (schemaStart === -1) {
    throw new Error(`${SCHEMA_SOURCE}: no \`const envSchema\` — the extractor below cannot work.`);
  }

  const defaultingHelpers = new Set<string>();
  for (let i = 0; i < schemaStart; i++) {
    const decl = /^(?:export\s+)?(const|function)\s+([A-Za-z_$][\w$]*)/.exec(lines[i] ?? "");
    const kind = decl?.[1];
    const name = decl?.[2];
    if (!kind || !name) continue;
    const body: string[] = [lines[i] ?? ""];
    for (let j = i + 1; j < schemaStart; j++) {
      const l = lines[j] ?? "";
      if (kind === "function") {
        // A function's body legitimately contains column-0 lines (its own
        // closing brace), so it ends at that brace instead.
        body.push(l);
        if (/^\}/.test(l)) break;
      } else {
        // A top-level (column-0) non-blank line ends a `const` declaration.
        if (l.trim() !== "" && /^\S/.test(l)) break;
        body.push(l);
      }
    }
    if (DEFAULTING.test(body.join("\n"))) defaultingHelpers.add(name);
  }

  // Schema keys sit at exactly 4-space indent inside `z.object({ … })` — the
  // same anchor AGENTS.md documents for listing the key set by hand.
  const KEY = /^ {4}([A-Z][A-Z0-9_]*):/;
  const helperCall = new RegExp(`\\b(?:${[...defaultingHelpers].join("|")})\\s*[<(]`);

  const keys = new Set<string>();
  const defaulted = new Set<string>();
  let current: string | null = null;
  let block: string[] = [];

  const flush = (): void => {
    if (current !== null) {
      const text = block.join("\n");
      if (DEFAULTING.test(text) || (defaultingHelpers.size > 0 && helperCall.test(text))) {
        defaulted.add(current);
      }
    }
    current = null;
    block = [];
  };

  for (const line of lines) {
    const key = KEY.exec(line);
    if (key?.[1]) {
      flush();
      current = key[1];
      keys.add(current);
      block = [line];
      continue;
    }
    // Anything that dedents to 3 columns or fewer closes the current key.
    if (current !== null) {
      if (/^ {0,3}\S/.test(line)) flush();
      else block.push(line);
    }
  }
  flush();

  return { keys, defaulted };
}

/**
 * The vacuity floor — under the extractor's OVERLAP WITH `CODE_DEFAULTS`, not
 * under its raw key count.
 *
 * Every other failure mode of this file is fail-CLOSED — renaming `envSchema`
 * throws, moving a helper below the schema throws — but the ONE that mattered
 * most was fail-open. `KEY = /^ {4}([A-Z][A-Z0-9_]*):/` anchors on exactly four
 * spaces; when that anchor stops matching, `keys` and `defaulted` are BOTH
 * empty, `assertExtractorStillWorks` intersects `CODE_DEFAULTS` with an empty
 * set, finds zero undetected entries, and returns happily. `findTableGaps` then
 * reports nothing for every file and the gate prints its tick. Demonstrated
 * 2026-08-25 against the real exported functions, re-indenting the real schema
 * from 4 spaces to 2: `keys: 0  defaulted: 0`, `assertExtractorStillWorks
 * threw? false`, and a compose line pinning `WORKSPACE_TMPFS_SIZE_MB=512` —
 * a real finding on the real schema — came back as `[]`.
 *
 * ─── Why the raw count could not do this job ─────────────────────────
 *
 * A floor of 50 on `keys.size` against 99 keys only ever caught total
 * collapse — the 0-key case above, which is the one mutation anybody had
 * measured. PARTIAL collapse is the likelier shape and it slid straight
 * through: giving the first 44 key blocks one extra level of indent (the
 * "object was split into spread groups" refactor this file's own failure text
 * names) yielded keys/defaulted of 55/34 instead of 99/67. 33 defaults gone,
 * still above 50, `assertExtractorStillWorks` silent, a REAL table-gap finding
 * on a real compose file gone with them, and the green tick printed.
 *
 * The companion check below cannot cover for it, by construction: it filters on
 * `keys.has(n)`, so a key the extractor LOST is excluded before it can be
 * counted as undetected. Losing keys makes that check quieter, not louder.
 *
 * So the floor moves onto `CODE_DEFAULTS ∩ keys`. `CODE_DEFAULTS` is this
 * repo's independent, hand-maintained statement of which variables the schema
 * defaults, so the intersection degrades one variable at a time as the
 * extractor loses ground, instead of holding steady until half the schema is
 * gone. Measured 2026-08-25: 58 table entries, 53 of them schema keys. The
 * other 5 — `OTEL_ENABLED`, `OTEL_SERVICE_NAME`, `OTEL_TRUST_INCOMING_TRACE`,
 * `SIDECAR_MAX_REQUEST_BODY_BYTES`, `SIDECAR_MAX_MCP_ENVELOPE_BYTES` — are read
 * straight from `process.env` outside the schema and legitimately never appear
 * in `keys`.
 *
 * 45 against a measured 53 is a FLOOR, not a pin: retiring a handful of table
 * entries never trips it, while the 44-block mutation above (which leaves 30 of
 * the 53) does. Re-measure with
 * `Object.keys(CODE_DEFAULTS).filter((n) => keys.has(n)).length`; raise it only
 * after re-measuring, and never lower it to make a red gate green.
 */
const MIN_TABLE_KEYS_FOUND = 45;

/**
 * Self-check on the extractor above, run before its output is trusted.
 *
 * Two independent checks, in the order a reader needs them: first that the
 * extractor produced a plausible key set at all (`MIN_SCHEMA_KEYS`), then that
 * every variable `CODE_DEFAULTS` and the schema BOTH name came back as
 * defaulted. The second is meaningless without the first — an empty key set
 * satisfies it trivially.
 *
 * The hand-maintained `CODE_DEFAULTS` is an independent statement that a
 * variable HAS a schema default. So every table entry that is also a schema key
 * must come back as defaulted; a single one that does not means the extractor
 * has stopped understanding the schema's style — a new helper shape, a
 * different indentation — and its silence would otherwise read as "no gaps".
 *
 * Entries absent from the schema entirely are NOT an error and are excluded
 * here: `OTEL_*` and the two `SIDECAR_MAX_*` vars are read straight from
 * `process.env` by the sidecar and by `@appstrate/module-observability`, which
 * is why `docs/ENV.md` documents them separately. The table covers them so
 * compose cannot mirror them either.
 *
 * ─── The half this cannot check ──────────────────────────────────────
 *
 * Its evidence is `CODE_DEFAULTS ∩ schema keys` — variables somebody has
 * already written down twice. So it detects a style change under an EXISTING
 * table entry, and nothing else. A brand-new variable introduced in a form the
 * extractor does not know (the `.transform((v) => v ?? …)` hole above) is
 * absent from the table by construction, contributes no intersection member,
 * and passes here in silence — which is precisely the "new variable in a new
 * form" case. Do not read a green run as coverage of that. The tests in
 * `scripts/test/verify-compose-defaults.test.ts` hold the recognised forms
 * against a synthetic schema, which is where a new form gets its assertion.
 *
 * Measured on today's schema (2026-08-25): 99 keys, 67 detected as defaulted.
 * The 32 remaining were re-read one by one — 30 contain no occurrence of
 * `default` / `catch` / `prefault` / `??` / `transform` at all, and the two
 * that trip a text search do not default: `GIT_SHA` matches only a trailing
 * comment about `TRUST_PROXY`, and `PLATFORM_API_URL`'s
 * `.transform((v) => (v === "" ? undefined : v))` produces `undefined`, not a
 * value. So on this schema the extractor is exact; the hole above is
 * forward-looking.
 */
export function assertExtractorStillWorks(keys: Set<string>, defaulted: Set<string>): void {
  const tableKeysFound = Object.keys(CODE_DEFAULTS).filter((name) => keys.has(name));
  if (tableKeysFound.length < MIN_TABLE_KEYS_FOUND) {
    throw new Error(
      `verify-compose-defaults: the ${SCHEMA_SOURCE} key extractor found only ` +
        `${tableKeysFound.length} of the ${Object.keys(CODE_DEFAULTS).length} variables ` +
        `CODE_DEFAULTS names (${keys.size} schema key(s) in total), below the floor of ` +
        `${MIN_TABLE_KEYS_FOUND} — 53 of 58 at the time of writing. ` +
        `The most likely cause is that the key anchor — a name at EXACTLY four spaces of indent, ` +
        `inside \`const envSchema\`'s \`z.object({ … })\` — no longer matches for some or all ` +
        `keys: the object was split into spread groups, or \`z\\n  .object({\` was collapsed to ` +
        `\`z.object({\`, moving keys one level out. Every key lost here is a compose line nothing ` +
        `compares, reported as a green tick. Fix the anchor in extractSchemaDefaults; do NOT ` +
        `lower this floor.`,
    );
  }

  const undetected = Object.keys(CODE_DEFAULTS)
    .filter((name) => keys.has(name) && !defaulted.has(name))
    .sort();
  if (undetected.length > 0) {
    throw new Error(
      `verify-compose-defaults: the ${SCHEMA_SOURCE} default extractor missed ` +
        `${undetected.length} variable(s) that CODE_DEFAULTS says have a default: ` +
        `${undetected.join(", ")}. The schema's style has changed and the extractor in this ` +
        `file has to follow it — leaving it as-is would silently shrink this gate's coverage.`,
    );
  }
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
  assertExtractorStillWorks(schemaKeys, schemaDefaulted);

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
    console.log(
      `\x1b[32m✓\x1b[0m verify-compose-defaults: no duplicated env defaults across ${COMPOSE_FILES.length} compose files ` +
        `(${schemaDefaulted.size} schema defaults known, all compose-pinned vars covered by the table).`,
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
