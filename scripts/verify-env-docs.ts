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
import { trackedFiles } from "./lib/tracked-files.ts";

const REPO_ROOT = join(import.meta.dir, "..");

const ENV_DOC = "docs/ENV.md";

/** Both shipped `.env.example` files — the root one and the self-hosting one. */
const ENV_EXAMPLE_GLOBS = ["*.env.example"] as const;

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
 * variables would let a retired spelling satisfy a live key's requirement. The
 * two tables are told apart by their header row (`| Variable |` vs `| Was |`),
 * not by line number.
 *
 * Pure — content in, names out — so `scripts/test/verify-env-docs.test.ts` can
 * drive it with synthetic Markdown.
 */
export function readDocumentedVars(markdown: string): Set<string> {
  const documented = new Set<string>();
  let inMainTable = false;

  for (const line of markdown.split("\n")) {
    if (line.startsWith("| Variable")) {
      inMainTable = true;
      continue;
    }
    // Any other table header ends the main table — today that is the retired
    // `| Was | Now | Governs |` table, and any future one gets the same answer.
    if (line.startsWith("|") && !inMainTable) continue;
    if (line.startsWith("| Was")) {
      inMainTable = false;
      continue;
    }
    if (!inMainTable) continue;
    const match = /^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/.exec(line);
    if (match) documented.add(match[1]!);
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

function main(): number {
  const schemaKeys = new Set(Object.keys(envSchema.shape));
  const documented = readDocumentedVars(readFileSync(join(REPO_ROOT, ENV_DOC), "utf-8"));

  const exampleFiles = trackedFiles(ENV_EXAMPLE_GLOBS, "env example file", "fail");
  const envExampleKeys = new Map<string, string>();
  for (const file of exampleFiles) {
    for (const name of readEnvExampleVars(readFileSync(join(REPO_ROOT, file), "utf-8"))) {
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
    console.error(
      `\x1b[31m✗\x1b[0m verify-env-docs: parsed ZERO rows out of ${ENV_DOC} — the gate would ` +
        "pass vacuously. Did the main table's `| Variable |` header change shape?",
    );
    return 1;
  }
  if (envExampleKeys.size === 0) {
    console.error(
      `\x1b[31m✗\x1b[0m verify-env-docs: parsed ZERO variables out of ${exampleFiles.length} ` +
        ".env.example file(s) — the gate would pass vacuously.",
    );
    return 1;
  }

  const findings = findUndocumented(schemaKeys, envExampleKeys, documented);

  if (findings.length === 0) {
    const schemaBacked = [...documented].filter((n) => schemaKeys.has(n)).length;
    console.log(
      `\x1b[32m✓\x1b[0m verify-env-docs: ${ENV_DOC} documents all ${schemaKeys.size} schema ` +
        `vars and every var in ${exampleFiles.length} .env.example file(s) ` +
        `(${documented.size} rows: ${schemaBacked} schema-backed, ${documented.size - schemaBacked} ` +
        `read straight from process.env; ${Object.keys(INFRA_ALLOWLIST).length} infra vars allowlisted).`,
    );
    return 0;
  }

  console.error(
    `\x1b[31m✗\x1b[0m verify-env-docs: ${findings.length} environment variable(s) have no row ` +
      `in ${ENV_DOC}.\n\n` +
      `${ENV_DOC} is hand-maintained on purpose — its Notes column carries cross-field boot\n` +
      `rules and failure behaviour no schema encodes, so this gate checks COMPLETENESS only and\n` +
      `never writes the file. Write the row yourself, from the code that reads the variable.\n`,
  );
  for (const f of findings) {
    console.error(`  \x1b[1m${f.name}\x1b[0m  \x1b[33m[${f.source}]\x1b[0m`);
    console.error(`    ${f.fix}`);
  }
  console.error("");
  return 1;
}

// Guarded so the test file can import the pure helpers above without the gate
// exiting the test process on import — same pattern as verify-compose-defaults.ts.
if (import.meta.main) {
  process.exit(main());
}
