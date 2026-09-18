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
 * The schema population is unioned with every discovered module schema, and a compose file that
 * passes through SOME of a module's variables must pass through all of them — the block is a
 * hand-maintained copy of the schema, and a name missing from it never reaches the container.
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
import { moduleEnvSchemas } from "./lib/module-env-schemas.ts";
import { COMPOSE_GLOBS, trackedFiles } from "./lib/tracked-files.ts";
import { modulesEnabledByDefault } from "./lib/compose-modules.ts";

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

/** One compose file forwarding part of a module's environment and not the rest. */
interface PassThroughGap {
  file: string;
  module: string;
  declaredIn: string;
  missing: string[];
  /** How many it does forward — 0 means the file is out of scope, not a gap. */
  present: number;
}

/** Every `- NAME` / `- NAME=…` entry a compose file lists. */
const COMPOSE_ENV_ENTRY = /^\s*-\s*([A-Z][A-Z0-9_]*)\s*(?:=|$)/gm;

/**
 * The pass-through gaps in one compose file. Pure, so the test can hold a synthetic compose
 * against a synthetic module schema. Forwarding SOME of a module's variables and not the rest is
 * the gap: the block is a hand-copied list, and a name dropped from it never reaches the
 * container.
 *
 * Forwarding NONE of them is not a gap, and the reason is no longer the obvious one. It used to
 * read "that file simply does not run the module", which was true while every compose file passed
 * `MODULES` through from the environment. `deploy/docker-compose.yml` now pins a default that
 * names a module AND forwards none of its variables — deliberately, since #1464: it delivers them
 * through `env_file`, because the orchestrator materialises every key an `environment:` block
 * names and a bare one arrives as `''`. So "forwards none" means one of two things, and this rule
 * is out of scope for both. `findUnroutedModules` below is what tells them apart.
 */
export function findPassThroughGaps(
  content: string,
  modules: readonly { id: string; file: string; keys: readonly string[] }[],
): Omit<PassThroughGap, "file">[] {
  const forwarded = new Set<string>();
  for (const match of content.matchAll(COMPOSE_ENV_ENTRY)) forwarded.add(match[1]!);

  const gaps: Omit<PassThroughGap, "file">[] = [];
  for (const module of modules) {
    const missing = module.keys.filter((name) => !forwarded.has(name));
    const present = module.keys.length - missing.length;
    if (present === 0 || missing.length === 0) continue;
    gaps.push({ module: module.id, declaredIn: module.file, missing, present });
  }
  return gaps;
}

/** A module a compose file boots while giving its variables no way in. */
export interface UnroutedModule {
  file: string;
  module: string;
  declaredIn: string;
  keys: number;
}

/**
 * Modules this file turns on BY DEFAULT and then leaves unconfigurable.
 *
 * The half of "forwards none of a module's variables" that is a defect. A file whose `MODULES`
 * default names a module boots it for anyone who runs the file as shipped, so the module's
 * variables have to arrive somehow: either forwarded one by one in `environment:`, or delivered
 * wholesale by `env_file`. Neither, and every one of them is `undefined` at boot — which for a
 * module with hard-required keys is a crash with the operator's own file as the cause.
 *
 * Deliberately blind to the orchestrator: a deployment platform that injects its own configuration
 * into every container would satisfy this too, and there is no way to see that from the file. What
 * it holds is that the file is self-sufficient as written, which is the property a `docker compose
 * up` from that directory actually depends on.
 */
export function findUnroutedModules(
  content: string,
  modules: readonly { id: string; file: string; keys: readonly string[] }[],
): Omit<UnroutedModule, "file">[] {
  if (/^\s*env_file:/m.test(content)) return [];

  const forwarded = new Set<string>();
  for (const match of content.matchAll(COMPOSE_ENV_ENTRY)) forwarded.add(match[1]!);
  const enabled = new Set(modulesEnabledByDefault(content));

  return modules
    .filter(
      (module) =>
        enabled.has(module.id) &&
        module.keys.length > 0 &&
        module.keys.every((name) => !forwarded.has(name)),
    )
    .map((module) => ({ module: module.id, declaredIn: module.file, keys: module.keys.length }));
}

/**
 * Compose files deployed by an orchestrator that MATERIALISES every key an `environment:` block
 * names — a bare `- FOO` is rewritten into `FOO: ''` in the compose it actually runs.
 *
 * Coolify does this, and it is why `deploy/` is in this list. The form this gate prescribes
 * everywhere else — name the variable, omit the value, let the schema's default apply — is not
 * merely unnecessary there, it is UNAVAILABLE: "unset" cannot be expressed.
 *
 * Measured 2026-09-18, after it took production down. `EE_RECONCILIATION_BATCH_SIZE` arrived as
 * `''`, `z.coerce.number("")` is 0, the module's own `.min(1)` refused it and the platform
 * crash-looped. Of the 19 bare names in that block, 12 were unsafe: 7 refused to boot and 4 more
 * would have degraded in SILENCE — a zero `EE_RECONCILIATION_INTERVAL_SECONDS` pauses metering, a
 * zero `EE_RECONCILIATION_REPLAY_WINDOW` disables the scan that keeps usage from going unbilled.
 * The `.min(1)` floor is the only reason any of it was visible at all.
 *
 * A LIST, not a heuristic. "Uses `env_file`" would select the same file today and would stop
 * selecting it the moment someone removed the line — which is the edit this rule exists to
 * refuse, silently un-checking itself as it happened. A path here is wrong only in the direction
 * that fails loudly: it names a file, and the vacuity check below notices when that file is gone.
 */
export const ORCHESTRATED_COMPOSE_FILES = ["deploy/docker-compose.yml"] as const;

/** A variable named with no value in a file whose orchestrator will materialise it as `''`. */
export interface BareNameFinding {
  file: string;
  line: number;
  varName: string;
}

/** `- FOO` with nothing after it: a name, no `=`, no value. */
const BARE_ENV_ENTRY = /^\s+- ([A-Z_][A-Z0-9_]*)\s*$/;

/**
 * Every bare name in one file. Pure, so the test can drive both verdicts on synthetic content.
 *
 * The repair is never "give it a value here" — that re-pins a default the schema already owns,
 * which is Class 1. It is `env_file`, which delivers the operator's whole contract at once and
 * leaves `environment:` to the values the compose file itself computes.
 */
export function findMaterialisableBareNames(content: string): Omit<BareNameFinding, "file">[] {
  return content
    .split("\n")
    .map((line, index) => ({ line: index + 1, match: BARE_ENV_ENTRY.exec(line) }))
    .filter((entry): entry is { line: number; match: RegExpExecArray } => entry.match !== null)
    .map((entry) => ({ line: entry.line, varName: entry.match[1]! }));
}

async function main(): Promise<number> {
  const findings: FileFinding[] = [];
  const gaps: TableGapFinding[] = [];
  const passThrough: PassThroughGap[] = [];
  const unrouted: UnroutedModule[] = [];
  const bare: BareNameFinding[] = [];

  const { keys: platformKeys, defaulted: platformDefaulted } = readSchemaDefaults();
  const moduleEnv = await moduleEnvSchemas(REPO_ROOT);
  const modules = moduleEnv.schemas.map((module) => ({
    id: module.id,
    file: module.file,
    keys: Object.keys(module.shape),
  }));
  const schemaKeys = new Set(platformKeys);
  const schemaDefaulted = new Set(platformDefaulted);
  for (const module of moduleEnv.schemas) {
    for (const [name, field] of Object.entries(module.shape)) {
      schemaKeys.add(name);
      if (suppliesValue(field)) schemaDefaulted.add(name);
    }
  }

  // The orchestrated list is written by hand, so it can name a file that moved. An entry with no
  // file behind it stops checking silently — the same fail-open the file list itself refuses.
  const unmatched = ORCHESTRATED_COMPOSE_FILES.filter((file) => !COMPOSE_FILES.includes(file));
  if (unmatched.length > 0) {
    console.error(
      `\x1b[31m✗\x1b[0m verify-compose-defaults: ORCHESTRATED_COMPOSE_FILES names ` +
        `${unmatched.length} file(s) this gate does not read: ${unmatched.join(", ")}. The bare-name ` +
        `check over them would pass vacuously. Update the constant, or restore the file.`,
    );
    return 1;
  }

  for (const file of COMPOSE_FILES) {
    const content = readFileSync(join(REPO_ROOT, file), "utf-8");
    for (const finding of analyzeComposeDefaults(content)) {
      findings.push({ ...finding, file });
    }
    for (const gap of findTableGaps(content, schemaDefaulted)) {
      gaps.push({ ...gap, file });
    }
    for (const gap of findPassThroughGaps(content, modules)) {
      passThrough.push({ ...gap, file });
    }
    for (const module of findUnroutedModules(content, modules)) {
      unrouted.push({ ...module, file });
    }
    if (ORCHESTRATED_COMPOSE_FILES.includes(file as (typeof ORCHESTRATED_COMPOSE_FILES)[number])) {
      for (const finding of findMaterialisableBareNames(content)) {
        bare.push({ ...finding, file });
      }
    }
  }

  if (
    findings.length === 0 &&
    gaps.length === 0 &&
    passThrough.length === 0 &&
    unrouted.length === 0 &&
    bare.length === 0
  ) {
    // What was compared, so a reader can tell at a glance which two populations
    // met: the compose files scanned, and the schema vars they were checked
    // against. Not a diagnostic — nothing here is load-bearing for correctness.
    const moduleKeyCount = modules.reduce((n, m) => n + m.keys.length, 0);
    console.log(
      `\x1b[32m✓\x1b[0m verify-compose-defaults: no duplicated env defaults across ${COMPOSE_FILES.length} compose files ` +
        `(${schemaDefaulted.size} of ${schemaKeys.size} env vars carry a schema default — ` +
        `${SCHEMA_SOURCE} plus ${moduleKeyCount} var(s) from ${modules.length} module schema(s); ` +
        `all compose-pinned vars covered by the table, every module pass-through block complete, ` +
        `every module a compose file enables by default reachable from it; no bare name in the ` +
        `${ORCHESTRATED_COMPOSE_FILES.length} orchestrated file(s)).`,
    );
    return 0;
  }

  const duplicates = findings.filter((f) => f.kind === "duplicate");
  const drifts = findings.filter((f) => f.kind === "allowlist-drift");

  console.error(
    `\x1b[31m✗\x1b[0m verify-compose-defaults: ` +
      `${findings.length + gaps.length + passThrough.length + unrouted.length + bare.length} ` +
      `issue(s) found (${duplicates.length} duplicates, ${drifts.length} ALLOWLIST drift, ` +
      `${gaps.length} table gap, ${passThrough.length} incomplete module pass-through, ` +
      `${unrouted.length} unroutable module, ${bare.length} materialisable bare name).\n`,
  );

  if (bare.length > 0) {
    console.error(
      `\x1b[1m── Class 6: bare name under an orchestrator that materialises keys ──\x1b[0m`,
    );
    console.error(
      `These files are deployed by an orchestrator that rewrites every key an \`environment:\`\n` +
        `block NAMES into \`KEY: ''\` in the compose it generates. So a bare entry does not mean\n` +
        `"unset, let the schema default apply" there — it means "set to the empty string", a state\n` +
        `the schema never sees during a raw run and is not written to survive. That took production\n` +
        `down on 2026-09-18; the constant above records the measurement.\n` +
        `Fix: delete the entry. \`env_file:\` already delivers the operator's variables, which is the\n` +
        `only form under which "unset" survives. Keep in \`environment:\` only what the compose file\n` +
        `itself computes: a service hostname, an image ref, a remap of one variable onto another.\n`,
    );
    for (const b of bare) {
      console.error(`  \x1b[1m${b.file}:${b.line}\x1b[0m  ${b.varName}`);
    }
    console.error("");
  }

  if (unrouted.length > 0) {
    console.error(`\x1b[1m── Class 5: module enabled with no way to configure it ──\x1b[0m`);
    console.error(
      `These compose files name a module in the DEFAULT of \`MODULES\`, so running the file as\n` +
        `shipped boots it — and then give its environment variables no route in: nothing forwarded\n` +
        `in \`environment:\`, no \`env_file:\`. Every one of them is undefined at boot, which for a\n` +
        `module with hard-required keys is a crash whose cause is the compose file itself.\n` +
        `Fix: add \`env_file:\` (the whole contract at once, and the only form that survives an\n` +
        `orchestrator that materialises bare keys), forward the names explicitly, or take the\n` +
        `module out of the \`MODULES\` default so it is opt-in again.\n`,
    );
    for (const u of unrouted) {
      console.error(
        `  \x1b[1m${u.file}\x1b[0m  module \`${u.module}\` (${u.declaredIn}): ` +
          `${u.keys} var(s), none reachable`,
      );
    }
    console.error("");
  }

  if (passThrough.length > 0) {
    console.error(`\x1b[1m── Class 4: incomplete module env pass-through ──\x1b[0m`);
    console.error(
      `These compose files forward SOME of a module's environment variables and not the rest.\n` +
        `A name absent from the block is not forwarded into the container at all: the module\n` +
        `reads process.env, sees nothing, and either falls back to a default or refuses to boot —\n` +
        `with nothing anywhere pointing at the compose file.\n` +
        `Fix: add the missing names to the same block, or drop the block entirely if that compose\n` +
        `file is not meant to run the module.\n`,
    );
    for (const g of passThrough) {
      console.error(
        `  \x1b[1m${g.file}\x1b[0m  module \`${g.module}\` (${g.declaredIn}): ` +
          `${g.present} of ${g.present + g.missing.length} var(s) forwarded`,
      );
      console.error(`    \x1b[33m[missing]\x1b[0m ${g.missing.join(", ")}`);
    }
    console.error("");
  }

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
  process.exit(await main());
}
