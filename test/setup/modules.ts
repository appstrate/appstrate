// SPDX-License-Identifier: Apache-2.0

/**
 * Module discovery, and what a discovered module needs from the test harness.
 *
 * Two processes read this, and a disagreement between them is a lie rather than
 * a bug: `test/setup/preload.ts` decides whether to import, register and
 * initialize a module, while `scripts/test-tier0.ts` decides whether bun
 * collects that module's own `test/**` files. A module the preload refuses to
 * load whose tests still run fails in a way that reads as a broken module. Both
 * answer the question from the same `<module>/test/requirements.ts`, through the
 * pure helpers below.
 *
 * `test/requirements.ts` is optional, like `test/tables.ts` beside it, and a
 * present-but-malformed one throws — a silently-ignored typo would leave the
 * module running in a tier it declared it cannot run in.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** A module directory found in one of the two module roots. */
export interface DiscoveredModule {
  /** Module root directory. */
  dir: string;
  /** Absolute path to the module's entry file. */
  entry: string;
}

function scanRoot(
  root: string,
  entryRel: string,
  dirPredicate: (name: string) => boolean,
): DiscoveredModule[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter(dirPredicate)
    .map((name) => ({ dir: join(root, name), entry: join(root, name, entryRel) }))
    .filter(({ dir, entry }) => statSync(dir).isDirectory() && existsSync(entry));
}

/**
 * Every module in the repo, from the two roots the harness recognises:
 *   - `apps/api/src/modules/<name>/index.ts` — built-in modules
 *   - `packages/module-<name>/src/index.ts` — workspace-package modules
 *
 * The `module-` prefix is the convention that distinguishes module workspace
 * packages from regular library packages (core, db, ui, …).
 */
export function discoverModules(repoRoot: string): DiscoveredModule[] {
  return [
    ...scanRoot(resolve(repoRoot, "apps/api/src/modules"), "index.ts", () => true),
    ...scanRoot(resolve(repoRoot, "packages"), "src/index.ts", (n) => n.startsWith("module-")),
  ];
}

/** What `<module>/test/requirements.ts` default-exports. */
export interface ModuleTestRequirements {
  /**
   * The module needs a real PostgreSQL and cannot run on the tier-0 PGlite
   * adapter. Under `TEST_TIER=0` it is not imported, not registered, not
   * initialized, and its own test files are not collected.
   */
  postgres?: boolean;
  /**
   * Env the harness applies with `??=` BEFORE importing the module entry —
   * modules read their configuration at import/init time, so anything set
   * afterwards is invisible to them. An operator value already in the
   * environment wins.
   */
  env?: Record<string, string>;
}

const SHAPE = "{ postgres?: boolean; env?: Record<string, string> }";

/**
 * Validate one `requirements.ts` default export. Pure, so
 * `test/setup/modules.test.ts` can drive every rejection without a fixture
 * module on disk.
 */
export function parseModuleRequirements(value: unknown, source: string): ModuleTestRequirements {
  if (value === undefined) {
    throw new Error(`${source} must default-export ${SHAPE} — it has no default export.`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `${source} must default-export ${SHAPE} — got ${Array.isArray(value) ? "an array" : typeof value}.`,
    );
  }

  const record: Record<string, unknown> = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    // Unknown keys are rejected rather than ignored: a misspelt `postgres`
    // would leave the module running in the tier it declared it cannot run in,
    // and the only symptom would be the failure it was meant to prevent.
    if (key !== "postgres" && key !== "env") {
      throw new Error(`${source} declares unknown requirement \`${key}\` — expected ${SHAPE}.`);
    }
  }

  const parsed: ModuleTestRequirements = {};
  const { postgres, env } = record;

  if (postgres !== undefined) {
    if (typeof postgres !== "boolean") {
      throw new Error(`${source}: \`postgres\` must be a boolean, got ${typeof postgres}.`);
    }
    parsed.postgres = postgres;
  }

  if (env !== undefined) {
    if (typeof env !== "object" || env === null || Array.isArray(env)) {
      throw new Error(`${source}: \`env\` must be an object of string values.`);
    }
    for (const [key, entry] of Object.entries(env)) {
      if (typeof entry !== "string") {
        throw new Error(`${source}: \`env.${key}\` must be a string, got ${typeof entry}.`);
      }
    }
    parsed.env = env as Record<string, string>;
  }

  return parsed;
}

/** Whether a module with these requirements has to sit out the current tier. */
export function skipsInTier(requirements: ModuleTestRequirements, tier0: boolean): boolean {
  return tier0 && requirements.postgres === true;
}

/**
 * The `env` entries `current` does not already carry — the `??=` the preload
 * applies, returned as a value so it can be asserted without mutating anything.
 */
export function envToApply(
  requirements: ModuleTestRequirements,
  current: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const toApply: Record<string, string> = {};
  for (const [key, value] of Object.entries(requirements.env ?? {})) {
    if (current[key] === undefined) toApply[key] = value;
  }
  return toApply;
}

/**
 * `<module>/test/requirements.ts`, or `{}` when the module declares none.
 *
 * Imported in two processes — the preload (with the platform test env already
 * set, so the file may derive values from `DATABASE_URL` and friends) and the
 * tier-0 runner (with only the ambient environment). It must therefore compute
 * a value rather than assert one: reading `process.env` is fine, throwing when
 * a variable is absent is not.
 */
export async function loadModuleRequirements(moduleDir: string): Promise<ModuleTestRequirements> {
  const file = join(moduleDir, "test", "requirements.ts");
  if (!existsSync(file)) return {};
  const imported: { default?: unknown } = await import(file);
  return parseModuleRequirements(imported.default, file);
}
