// SPDX-License-Identifier: Apache-2.0

/**
 * Module discovery, and what a discovered module needs from the test harness.
 * `preload.ts` (load it?) and `scripts/test-tier0.ts` (collect its tests?) must
 * agree, so both read the same optional `<module>/test/requirements.ts`, and a
 * malformed one throws instead of running in the tier it ruled out.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** A module root and the absolute path to its entry file. */
export interface DiscoveredModule {
  dir: string;
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

/** Every module: `apps/api/src/modules/<n>/index.ts`, `packages/module-<n>/src/index.ts`. */
export function discoverModules(repoRoot: string): DiscoveredModule[] {
  return [
    ...scanRoot(resolve(repoRoot, "apps/api/src/modules"), "index.ts", () => true),
    ...scanRoot(resolve(repoRoot, "packages"), "src/index.ts", (n) => n.startsWith("module-")),
  ];
}

export interface ModuleTestRequirements {
  /** Needs real PostgreSQL; under `TEST_TIER=0` it is not loaded and its tests not run. */
  postgres?: boolean;
  /**
   * Env force-assigned BEFORE the entry is imported (configuration is read at
   * import/init) and OVERRIDING the ambient one: a developer `.env` naming a
   * real database is what the suite would otherwise truncate and drop.
   */
  env?: Record<string, string>;
}

const SHAPE = "{ postgres?: boolean; env?: Record<string, string> }";

/** Validate one `requirements.ts` default export. Pure — see `modules.test.ts`. */
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
    // Rejected, not ignored: a misspelt `postgres` would run the module in the
    // tier it declared it cannot run in, and the only symptom is that failure.
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

export function skipsInTier(requirements: ModuleTestRequirements, tier0: boolean): boolean {
  return tier0 && requirements.postgres === true;
}

/**
 * `<module>/test/requirements.ts`, or `{}`. Imported by the preload (platform
 * test env set) AND the tier-0 runner (ambient env only): compute, never assert.
 */
export async function loadModuleRequirements(moduleDir: string): Promise<ModuleTestRequirements> {
  const file = join(moduleDir, "test", "requirements.ts");
  if (!existsSync(file)) return {};
  const imported: { default?: unknown } = await import(file);
  return parseModuleRequirements(imported.default, file);
}
