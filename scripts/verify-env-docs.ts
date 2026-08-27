// SPDX-License-Identifier: Apache-2.0

/**
 * Verify that `docs/ENV.md` documents every environment variable the platform
 * declares or ships an example for.
 *
 * ─── What this gate is NOT ───────────────────────────────────────────
 *
 * It is not a generator, and turning it into one would destroy the half of
 * `docs/ENV.md` that works. Measured at `v1.0.0-beta.53`, ZERO of the
 * documented defaults disagreed with the schema — the mechanically derivable
 * column was already 100% correct — while the Notes column carried cross-field
 * boot rules, egress redirect semantics, failure behaviour at each limit and a
 * retired-name migration table, none of which any Zod schema encodes. What was
 * actually broken was COMPLETENESS: two schema keys and seven `.env.example`
 * keys had no row at all, and `FIRECRACKER_RUNNER_URL`/`_TOKEN` existed only as
 * a mention inside another row's Notes cell.
 *
 * So this gate checks the half a machine can check and leaves the prose alone:
 *
 *   keys(envSchema)        ⊆ rows(ENV.md)
 *   keys(*.env.example)    ⊆ rows(ENV.md) ∪ INFRA_ALLOWLIST
 *   required(envSchema)    ⊆ keys(EACH shipped .env.example)
 *
 * ─── Why the third line exists ───────────────────────────────────────
 *
 * The first two are subset checks in one direction, and a subset check is blind
 * to what is MISSING from the smaller set. Measured: `CONNECT_SESSION_SECRET`
 * is hard-required by the schema (`.min(1)`, keys ≥16 chars, no default — the
 * process cannot boot without it) and every self-hosting compose file
 * interpolates it fail-hard as `${CONNECT_SESSION_SECRET:?Set …}`. It was
 * absent from `examples/self-hosting/.env.example`, so a user following the
 * self-hosting guide got an ABORTED `docker compose up`, and nothing here could
 * see it: an absent key is trivially a subset of the rows.
 *
 * "Required" means "the Zod schema rejects `undefined`" — asked of the schema
 * itself (`shape[key].safeParse(undefined)`), not of a hand-kept list, so a key
 * that gains or loses a default moves in and out of scope on its own. A key
 * WITH a default is deliberately not forced into the examples: the whole point
 * of a default is that an operator need not write it down, and an example file
 * that restated all 94 of them would be noise.
 *
 * The population is EVERY shipped `.env.example` — `ENV_EXAMPLE_GLOBS`, the
 * same list the second line uses — because each one is a starting point somebody
 * copies. Narrowing it to the root file would have left exactly the file the
 * defect was in unchecked.
 *
 * It deliberately does not check the reverse direction. A documented row with
 * no schema key and no `.env.example` entry is the normal shape of a var read
 * straight from `process.env` by a module, the sidecar or the runtime image
 * (`OTEL_*`, `RUNNER_IMAGE_*`, `CHAT_PI_MAX_CONCURRENCY`), so "orphan row"
 * would fire on 21 correct rows and need an allowlist longer than the finding.
 *
 * Usage: bun scripts/verify-env-docs.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { envSchema } from "../packages/env/src/index.ts";
import { ENV_EXAMPLE_GLOBS, trackedFiles } from "./lib/tracked-files.ts";

const REPO_ROOT = join(import.meta.dir, "..");

const ENV_DOC = "docs/ENV.md";

/**
 * Variables that appear in a shipped `.env.example` and deliberately have NO
 * row in `docs/ENV.md`, with the reason each one is out of scope.
 *
 * `docs/ENV.md` documents what the PLATFORM reads. Everything below is read by
 * something else that happens to be configured from the same file — a sibling
 * container's entrypoint, docker compose's own interpolation, or a vendor SDK's
 * private credential chain. Documenting them in the platform's env table would
 * imply `getEnv()` knows about them, and it does not: none of these names
 * appears in `packages/env/src/index.ts` at all.
 *
 * An entry here is a claim that has to stay true, so it carries its consumer.
 * Adding a name to silence a finding — rather than because the platform really
 * does not read it — rebuilds the hole this gate closes.
 */
const INFRA_ALLOWLIST: Record<string, string> = {
  POSTGRES_USER: "read by the `postgres` container's entrypoint; the platform reads DATABASE_URL",
  POSTGRES_PASSWORD:
    "read by the `postgres` container's entrypoint; the platform reads DATABASE_URL",
  MINIO_ROOT_USER: "read by the `minio` container's entrypoint; the platform reads S3_*",
  MINIO_ROOT_PASSWORD: "read by the `minio` container's entrypoint; the platform reads S3_*",
  AWS_ACCESS_KEY_ID:
    "consumed by the AWS SDK's own credential-provider chain inside @appstrate/core/storage-s3; never named by platform code",
  AWS_SECRET_ACCESS_KEY:
    "consumed by the AWS SDK's own credential-provider chain inside @appstrate/core/storage-s3; never named by platform code",
  APPSTRATE_VERSION:
    "compose-level image-tag interpolation, never read by the platform process; kept current by `bun run verify:release-version`",
  DOCKER_GID:
    "compose-level: the host gid the container joins to reach the docker socket. Appears only in compose files",
  APPSTRATE_RUNNER_SOCKET_DIR:
    "compose-level bind-mount path for the appstrate-runner UDS, written by `appstrate install`. The platform reads FIRECRACKER_RUNNER_URL, not this",
};

/**
 * The variables `docs/ENV.md`'s MAIN table documents.
 *
 * The second table in the file — "File limits — renamed from `DOCUMENT_*`" —
 * is deliberately excluded. Its rows are RETIRED names that boot now refuses,
 * mirroring `RETIRED_ENV_RENAMES` in the schema; counting them as documented
 * variables would let a retired spelling satisfy a live key's requirement.
 *
 * ─── Any table header closes the main table, not just `| Was` ────────
 *
 * That is what this comment used to CLAIM while the code tested for `| Was`
 * specifically. Measured against the exported parser: a doc with the main
 * table followed by a third table headed `| Name | Meaning |` returned
 * `["LIVE_ONE", "SHOULD_NOT_COUNT"]` — every backticked name under the third
 * header counted as documented. So adding, say, a "Deprecated / Replacement"
 * table to `docs/ENV.md` would let a LIVE schema key lose its row and keep this
 * gate green, because the retired spelling in the new table answers for it.
 *
 * The implementation now matches the comment, which is also the safer of the
 * two behaviours: a table this parser has never seen is a table whose meaning
 * it does not know, and the answer to "is this documentation?" for an unknown
 * table is no. Adding a new table costs nothing; adding one whose rows SHOULD
 * count means giving it the `| Variable |` header, which is a decision someone
 * makes on purpose.
 *
 * Rows are told apart by shape rather than by position: a separator row is
 * dashes and pipes, a variable row's first cell is a backticked
 * `SCREAMING_SNAKE` name, and anything else that starts a table cell with plain
 * text is a header row. Only a header row moves the in/out state.
 *
 * Pure — content in, names out — so `scripts/test/verify-env-docs.test.ts` can
 * drive it with synthetic Markdown.
 */
export function readDocumentedVars(markdown: string): Set<string> {
  const documented = new Set<string>();
  let inMainTable = false;

  /** `| --- | :--: | ---: |` — the row under every markdown table header. */
  const SEPARATOR_ROW = /^\|[\s:|-]+$/;
  /** `| \`SOME_VAR\` | …` — a documented variable. */
  const VARIABLE_ROW = /^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/;
  /** `| Variable | Required | …` — a header row, captured so it can be identified. */
  const HEADER_ROW = /^\|\s*([A-Za-z][^|]*?)\s*\|/;

  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    if (SEPARATOR_ROW.test(line)) continue;

    const variable = VARIABLE_ROW.exec(line);
    if (variable) {
      if (inMainTable) documented.add(variable[1]!);
      continue;
    }

    const header = HEADER_ROW.exec(line);
    if (header) inMainTable = header[1] === "Variable";
  }

  return documented;
}

/**
 * The variables a `.env.example` mentions, commented lines included.
 *
 * Commented lines ARE the point: nearly every optional variable ships as
 * `# VAR=value` so an operator can uncomment it, and reading only live
 * assignments would see about a dozen of the 122 names in the root file.
 */
export function readEnvExampleVars(content: string): Set<string> {
  const names = new Set<string>();
  for (const line of content.split("\n")) {
    const match = /^\s*#?\s*([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match) names.add(match[1]!);
  }
  return names;
}

/**
 * The schema keys the process CANNOT boot without.
 *
 * Asked of the schema rather than kept as a list: a key is required exactly
 * when its own Zod type rejects `undefined`, which is the same question the
 * boot path asks. `.default(…)` and `.optional()` both accept it; a bare
 * `z.string().min(1)` does not. So a key that gains a default leaves this set
 * on its own, and one that loses a default joins it — with no roster to
 * remember, which is the property that makes the check survive.
 *
 * Exported so the test can drive it against synthetic schemas AND assert the
 * real one's answer, without the test re-deriving "required" and therefore
 * agreeing with a broken derivation.
 */
export function requiredSchemaKeys(
  shape: Record<string, { safeParse: (v: unknown) => { success: boolean } }>,
): Set<string> {
  const required = new Set<string>();
  for (const [name, type] of Object.entries(shape)) {
    if (!type.safeParse(undefined).success) required.add(name);
  }
  return required;
}

/** A required schema key that a shipped `.env.example` does not mention. */
export interface MissingRequired {
  name: string;
  file: string;
}

/**
 * Every (required key, shipped example) pair where the example is silent.
 *
 * The direction the two subset checks cannot see — see the header. Pure, and
 * taking the per-file key sets rather than the merged map, because the defect
 * is per-FILE: `CONNECT_SESSION_SECRET` was present in the root `.env.example`
 * and absent from the self-hosting one, and a merged population reports that as
 * covered.
 */
export function findMissingRequired(
  required: ReadonlySet<string>,
  perFile: ReadonlyMap<string, ReadonlySet<string>>,
): MissingRequired[] {
  const missing: MissingRequired[] = [];
  for (const [file, names] of [...perFile].sort(([a], [b]) => a.localeCompare(b))) {
    for (const name of [...required].sort()) {
      if (!names.has(name)) missing.push({ name, file });
    }
  }
  return missing;
}

/** One undocumented variable, and which population demanded a row for it. */
interface Finding {
  name: string;
  source: string;
  fix: string;
}

/**
 * The findings, given the three populations. Pure, so the test can assert both
 * halves of the discrimination without touching the repo's real files.
 */
export function findUndocumented(
  schemaKeys: ReadonlySet<string>,
  envExampleKeys: ReadonlyMap<string, string>,
  documented: ReadonlySet<string>,
): Finding[] {
  const findings: Finding[] = [];

  for (const name of [...schemaKeys].sort()) {
    if (documented.has(name)) continue;
    findings.push({
      name,
      source: "declared in the @appstrate/env Zod schema",
      fix: `add a row to ${ENV_DOC} — it is validated and fail-fast at boot, so an operator can hit it`,
    });
  }

  for (const [name, file] of [...envExampleKeys].sort(([a], [b]) => a.localeCompare(b))) {
    if (documented.has(name) || schemaKeys.has(name)) continue;
    if (name in INFRA_ALLOWLIST) continue;
    findings.push({
      name,
      source: `shipped in ${file}`,
      fix: `add a row to ${ENV_DOC} (with the \`[not in the Zod schema]\` tag and the process that reads it), or — only if the PLATFORM genuinely never reads it — add it to INFRA_ALLOWLIST in this script with its real consumer`,
    });
  }

  return findings;
}

/**
 * Everything `main` reaches for outside itself, so a test can reach in.
 *
 * The four branches that END this gate — both vacuity floors, the
 * missing-required report and the undocumented report — were unreachable from
 * a test while `main` was unexported and welded to `readFileSync` +
 * `trackedFiles`. Deleting either floor left the suite green, and a deleted
 * floor is precisely a gate that passes over an empty population. The defaults
 * are the production wiring and are resolved inside the function, so importing
 * this module still spawns no `git` and reads no file.
 */
export interface MainDeps {
  /** The `.env.example` files to read. Default: every tracked one. */
  exampleFiles?: readonly string[];
  /** Reads one repo-relative path. Default: from disk. */
  readFile?: (relativePath: string) => string;
  /** The schema key set. Default: the real `envSchema`'s keys. */
  schemaKeys?: ReadonlySet<string>;
  /** The keys that reject `undefined`. Default: derived from the real `envSchema`. */
  required?: ReadonlySet<string>;
  out?: (message: string) => void;
  err?: (message: string) => void;
}

export function main(deps: MainDeps = {}): number {
  const readFile =
    deps.readFile ?? ((rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf-8"));
  const out = deps.out ?? ((m: string): void => console.log(m));
  const err = deps.err ?? ((m: string): void => console.error(m));
  const schemaKeys = deps.schemaKeys ?? new Set(Object.keys(envSchema.shape));
  const required = deps.required ?? requiredSchemaKeys(envSchema.shape);
  const documented = readDocumentedVars(readFile(ENV_DOC));

  const exampleFiles =
    deps.exampleFiles ?? trackedFiles(ENV_EXAMPLE_GLOBS, "env example file", "fail");
  const perFile = new Map<string, ReadonlySet<string>>();
  const envExampleKeys = new Map<string, string>();
  for (const file of exampleFiles) {
    const names = readEnvExampleVars(readFile(file));
    perFile.set(file, names);
    for (const name of names) {
      if (!envExampleKeys.has(name)) envExampleKeys.set(name, file);
    }
  }

  // Vacuity floors. Each of the three populations can silently empty — a
  // reformatted table, a renamed schema export, a glob that stops matching —
  // and an empty population makes its half of the subset check trivially true.
  // `verify-compose-defaults.ts` grew three of these around a text parser for
  // exactly this reason; here the schema is read off the OBJECT and cannot
  // empty without a TypeScript error, but the two text parsers can.
  if (documented.size === 0) {
    err(
      `\x1b[31m✗\x1b[0m verify-env-docs: parsed ZERO rows out of ${ENV_DOC} — the gate would ` +
        "pass vacuously. Did the main table's `| Variable |` header change shape?",
    );
    return 1;
  }
  if (envExampleKeys.size === 0) {
    err(
      `\x1b[31m✗\x1b[0m verify-env-docs: parsed ZERO variables out of ${exampleFiles.length} ` +
        ".env.example file(s) — the gate would pass vacuously.",
    );
    return 1;
  }

  // Reported before the documentation findings: a self-hoster who copies an
  // example missing a hard-required key does not get a confusing app, they get
  // an aborted `docker compose up` (the compose templates interpolate these
  // fail-hard as `${KEY:?…}`). That is a broken install, not a doc gap.
  const missingRequired = findMissingRequired(required, perFile);
  if (missingRequired.length > 0) {
    err(
      `\x1b[31m✗\x1b[0m verify-env-docs: ${missingRequired.length} hard-required schema ` +
        `variable(s) are missing from a shipped .env.example.\n\n` +
        `These keys have NO default — the platform refuses to boot without them, and the ` +
        `self-hosting compose files interpolate them as \`\${KEY:?…}\`, so \`docker compose up\` ` +
        `aborts before a container starts. An example file that omits one hands the operator a ` +
        `broken install at step one.\n\n` +
        `Fix: add the key to the file below, commented or not, with a generated value or the ` +
        `command that generates one. If it should NOT be required, give it a default in ` +
        `packages/env/src/index.ts — this check reads the schema, not a list.\n`,
    );
    for (const m of missingRequired) {
      err(`  \x1b[1m${m.name}\x1b[0m  missing from \x1b[1m${m.file}\x1b[0m`);
    }
    err("");
    return 1;
  }

  const findings = findUndocumented(schemaKeys, envExampleKeys, documented);

  if (findings.length === 0) {
    const schemaBacked = [...documented].filter((n) => schemaKeys.has(n)).length;
    out(
      `\x1b[32m✓\x1b[0m verify-env-docs: ${ENV_DOC} documents all ${schemaKeys.size} schema ` +
        `vars and every var in ${exampleFiles.length} .env.example file(s) ` +
        `(${documented.size} rows: ${schemaBacked} schema-backed, ${documented.size - schemaBacked} ` +
        `read straight from process.env; ${Object.keys(INFRA_ALLOWLIST).length} infra vars ` +
        `allowlisted), and all ${required.size} hard-required vars appear in every example file.`,
    );
    return 0;
  }

  err(
    `\x1b[31m✗\x1b[0m verify-env-docs: ${findings.length} environment variable(s) have no row ` +
      `in ${ENV_DOC}.\n\n` +
      `${ENV_DOC} is hand-maintained on purpose — its Notes column carries cross-field boot\n` +
      `rules and failure behaviour no schema encodes, so this gate checks COMPLETENESS only and\n` +
      `never writes the file. Write the row yourself, from the code that reads the variable.\n`,
  );
  for (const f of findings) {
    err(`  \x1b[1m${f.name}\x1b[0m  \x1b[33m[${f.source}]\x1b[0m`);
    err(`    ${f.fix}`);
  }
  err("");
  return 1;
}

// Guarded so the test file can import the pure helpers above without the gate
// exiting the test process on import — same pattern as verify-compose-defaults.ts.
if (import.meta.main) {
  process.exit(main());
}
